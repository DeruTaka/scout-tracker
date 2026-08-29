// Local web UI: paste replay URLs, see both teams + importable pastes, browse
// the per-trainer unique-set library, and (re)build the sheet.
import express from 'express';
import { fileURLToPath } from 'node:url';
import type { Datastore } from '../store/datastore.js';
import type { Config } from '../config.js';
import type { ScoutedReplay } from '../types.js';
import { ingestReplays, previewReplay, writeOutputs, scoutUserReplays, refreshStore } from '../ingest.js';
import { googleConfigFromEnv, googleAuthConfigured } from '../sheet/google-sheets.js';
import { getGen, spriteSlug, genFromFormatId } from '../data/dex.js';
import { buildThreatProfile } from '../matchup/threat-profile.js';
import { buildCounterTeam } from '../matchup/team-builder.js';
import { exportSet } from '../build/pokemon-set.js';
import { BackgroundJob } from './job.js';

function splitInputs(text: string): string[] {
  return String(text || '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Strip the huge log from the replay before sending to the browser. */
function serialize(scouted: ScoutedReplay) {
  const { log, ...replay } = scouted.replay;
  return { replay, teams: scouted.teams };
}

export function startServer(store: Datastore, config: Config, port: number): void {
  // Defense in depth: an uncaught exception or unhandled rejection anywhere
  // in the process — including in something fired-and-forgotten by a
  // BackgroundJob, which Express's own per-route try/catch can't reach —
  // otherwise crashes the ENTIRE server for every user, not just whatever
  // request triggered it. That's a worse outcome than logging it and staying
  // up: this is a single local/small-deployment process, not something with
  // per-request isolation to fall back on, so losing the whole service over
  // one bad response is the wrong tradeoff. Every code path that can throw
  // should still be caught properly at its source — this only exists to stop
  // something nobody caught from taking the whole app down with it.
  process.on('uncaughtException', (err) => {
    console.error('[uncaughtException] server stayed up, but this indicates a real bug:', err);
  });
  process.on('unhandledRejection', (reason) => {
    console.error('[unhandledRejection] server stayed up, but this indicates a real bug:', reason);
  });

  const app = express();
  app.use(express.json({ limit: '2mb' }));

  // Optional access gate for public hosting. When SCOUT_PASSWORD is set, every
  // request needs HTTP Basic auth (any username, that password). Without it the
  // instance is open — fine for localhost, NOT for a public URL that writes to
  // your Google Sheet.
  const password = process.env.SCOUT_PASSWORD;
  if (password) {
    app.use((req, res, next) => {
      const [, b64] = (req.headers.authorization || '').split(' ');
      const [, pass] = Buffer.from(b64 || '', 'base64').toString().split(':');
      if (pass === password) return next();
      res.set('WWW-Authenticate', 'Basic realm="team-scouter"').status(401).send('Authentication required');
    });
  }

  const publicDir = fileURLToPath(new URL('./public', import.meta.url));
  app.use(express.static(publicDir));

  // Clean URLs for the extra pages.
  app.get('/sheet', (_req, res) => res.sendFile(fileURLToPath(new URL('./public/sheet.html', import.meta.url))));
  app.get('/teams', (_req, res) => res.sendFile(fileURLToPath(new URL('./public/teams.html', import.meta.url))));
  app.get('/counter', (_req, res) => res.sendFile(fileURLToPath(new URL('./public/counter.html', import.meta.url))));

  app.get('/api/status', (_req, res) => {
    res.json({
      googleConfigured: !!googleConfigFromEnv() && googleAuthConfigured(),
      replays: store.replays.length,
      uniqueSets: store.uniqueSets.length,
      sheetEmbedUrl: config.sheetEmbedUrl ?? null,
    });
  });

  app.post('/api/preview', async (req, res) => {
    try {
      const inputs = splitInputs(req.body?.urls);
      const scouted = [];
      for (const input of inputs) scouted.push(serialize(await previewReplay(input, store)));
      res.json({ scouted });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  // Bulk replay work (scouting a trainer's whole history, ingesting a big
  // pasted list, re-deriving the whole store) can run for minutes — long
  // past what any reverse proxy/host will hold a single request open for.
  // A request that outlives that timeout comes back to the browser as an
  // HTML error page, and `.json()`-ing that throws client-side; worse, the
  // server keeps the original request running regardless, so a client that
  // just retries piles up redundant work. All three run as a background job
  // the client polls instead — the POST returns immediately, a GET reports
  // progress, exactly like /api/refresh already did.
  const ingestJob = new BackgroundJob<{ results: ReturnType<typeof serializeIngestResults>; output: Awaited<ReturnType<typeof writeOutputs>> }>();
  const scoutUserJob = new BackgroundJob<{ user: string; found: number; results: ReturnType<typeof serializeIngestResults>; output: Awaited<ReturnType<typeof writeOutputs>> }>();
  const refreshJob = new BackgroundJob<{ errors: { id: string; error: string }[] }>();

  function serializeIngestResults(results: Awaited<ReturnType<typeof ingestReplays>>) {
    return results.map((r) => ({
      id: r.id,
      skipped: r.skipped,
      error: r.error,
      stats: r.stats,
      scouted: r.scouted ? serialize(r.scouted) : undefined,
    }));
  }

  app.post('/api/ingest', (req, res) => {
    const inputs = splitInputs(req.body?.urls);
    if (!inputs.length) { res.status(400).json({ error: 'urls is required' }); return; }
    const force = !!req.body?.force;
    const { started, error } = ingestJob.start(inputs.length, async (onProgress) => {
      const results = await ingestReplays(inputs, store, { force, onProgress });
      store.save();
      const output = await writeOutputs(store, config.xlsxPath);
      return { results: serializeIngestResults(results), output };
    });
    if (!started) { res.status(409).json({ error }); return; }
    res.json({ started: true, total: inputs.length });
  });
  app.get('/api/ingest', (_req, res) => res.json(ingestJob.current));

  app.post('/api/scout-user', (req, res) => {
    const user = String(req.body?.user || '').trim();
    if (!user) { res.status(400).json({ error: 'user is required' }); return; }
    const max = Math.max(1, Math.min(200, Number(req.body?.max) || 50));
    const force = !!req.body?.force;
    const format = req.body?.format ? String(req.body.format).trim() : undefined;
    const { started, error } = scoutUserJob.start(max, async (onProgress) => {
      const { found, results } = await scoutUserReplays(user, store, { max, force, format, onProgress });
      store.save();
      const output = await writeOutputs(store, config.xlsxPath);
      return { user, found, results: serializeIngestResults(results), output };
    });
    if (!started) { res.status(409).json({ error }); return; }
    res.json({ started: true });
  });
  app.get('/api/scout-user', (_req, res) => res.json(scoutUserJob.current));

  app.post('/api/refresh', (_req, res) => {
    const total = store.replays.length;
    const { started, error } = refreshJob.start(total, async (onProgress) => {
      const { errors } = await refreshStore(store, onProgress);
      store.save();
      await writeOutputs(store, config.xlsxPath);
      return { errors };
    });
    if (!started) { res.status(409).json({ error }); return; }
    res.json({ started: true, total });
  });
  app.get('/api/refresh', (_req, res) => res.json(refreshJob.current));

  // Building a counter-team means an async lookup (local store, then Smogon
  // dex/usage stats, network-backed) for every candidate species in the
  // format — for a VR-driven tier like gen9nationaldexubers that's 100+
  // species, run mostly sequentially. That routinely runs well past what a
  // reverse proxy/host holds a request open for, hitting the exact
  // HTML-error-page-instead-of-JSON failure documented above /api/ingest —
  // so this runs as a background job too, POST-then-poll like the rest.
  const counterTeamJob = new BackgroundJob<{
    threats: Awaited<ReturnType<typeof buildCounterTeam>>['threats'];
    resolvedThreats: (Awaited<ReturnType<typeof buildCounterTeam>>['resolvedThreats'][number] & { sprite: string })[];
    team: (Awaited<ReturnType<typeof buildCounterTeam>>['team'][number] & { sprite: string; paste: string })[];
    unmetRequirements: string[];
    warnings: string[];
  }>();

  app.post('/api/counter-team', (req, res) => {
    const input = String(req.body?.input || '').trim();
    if (!input) { res.status(400).json({ error: 'input is required (a usage table or a PokePaste URL)' }); return; }
    const formatid = String(req.body?.formatid || 'gen9ubers').trim();
    const { started, error } = counterTeamJob.start(1, async () => {
      const gen = getGen(genFromFormatId(formatid));
      const threats = await buildThreatProfile(gen, input);
      const result = await buildCounterTeam(store, gen, formatid, threats);

      const resolvedThreats = result.resolvedThreats.map((t) => ({ ...t, sprite: spriteSlug(gen, t.set.species) }));
      const team = result.team.map((pick) => ({
        ...pick,
        sprite: spriteSlug(gen, pick.set.species),
        paste: exportSet(pick.set),
      }));

      return { threats: result.threats, resolvedThreats, team, unmetRequirements: result.unmetRequirements, warnings: result.warnings };
    });
    if (!started) { res.status(409).json({ error }); return; }
    res.json({ started: true });
  });
  app.get('/api/counter-team', (_req, res) => res.json(counterTeamJob.current));

  app.get('/api/player-usage', (req, res) => {
    const player = String(req.query.player || '').trim();
    if (!player) { res.status(400).json({ error: 'player is required' }); return; }
    const formatid = req.query.formatid ? String(req.query.formatid) : undefined;
    const usage = store.getPlayerUsage(player, formatid);
    if (usage) {
      const gen = getGen(9); // sprite/forme data is stable across modern gens
      for (const s of usage.species) (s as any).sprite = spriteSlug(gen, s.species);
    }
    res.json({ usage });
  });

  app.get('/api/teams', (_req, res) => {
    const teams = [];
    for (const r of store.replays) {
      const gen = getGen(r.gen);
      for (const t of r.teams) {
        teams.push({
          replayId: r.id,
          url: r.url,
          format: r.format,
          formatid: r.formatid,
          uploadtime: r.uploadtime,
          date: r.uploadtime ? new Date(r.uploadtime * 1000).toISOString().slice(0, 10) : '',
          player: t.player,
          side: t.side,
          winner: r.winner,
          result: r.winner ? (r.winner === t.player ? 'W' : 'L') : '',
          paste: t.paste,
          mons: t.sets.map((s) => ({ species: s.species, sprite: spriteSlug(gen, s.species), unrevealed: !!s.unrevealed })),
        });
      }
    }
    res.json({ teams });
  });

  app.get('/api/replays', (_req, res) => {
    res.json({
      replays: store.replays.map((r) => ({
        id: r.id, url: r.url, format: r.format, players: r.players,
        uploadtime: r.uploadtime, winner: r.winner,
      })),
    });
  });

  app.listen(port, () => {
    console.log(`Team-Scouter web UI: http://localhost:${port}`);
    console.log(`  store: ${config.storePath}`);
    console.log(`  xlsx:  ${config.xlsxPath}`);
    const g = googleConfigFromEnv() && googleAuthConfigured();
    console.log(g ? '  Google Sheet: configured' : '  Google Sheet: not configured (local .xlsx only)');
    if (password) console.log('  Access gate: password required');
  });
}
