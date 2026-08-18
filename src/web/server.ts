// Local web UI: paste replay URLs, see both teams + importable pastes, browse
// the per-trainer unique-set library, and (re)build the sheet.
import express from 'express';
import { fileURLToPath } from 'node:url';
import type { Datastore } from '../store/datastore.js';
import type { Config } from '../config.js';
import type { ScoutedReplay } from '../types.js';
import { ingestReplays, previewReplay, writeOutputs, scoutUserReplays } from '../ingest.js';
import { googleConfigFromEnv, googleAuthConfigured } from '../sheet/google-sheets.js';
import { getGen, spriteSlug } from '../data/dex.js';

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

  app.post('/api/ingest', async (req, res) => {
    try {
      const inputs = splitInputs(req.body?.urls);
      const results = await ingestReplays(inputs, store, { force: !!req.body?.force });
      store.save();
      const output = await writeOutputs(store, config.xlsxPath);
      res.json({
        results: results.map((r) => ({
          id: r.id,
          skipped: r.skipped,
          error: r.error,
          stats: r.stats,
          scouted: r.scouted ? serialize(r.scouted) : undefined,
        })),
        output,
      });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.post('/api/scout-user', async (req, res) => {
    try {
      const user = String(req.body?.user || '').trim();
      if (!user) { res.status(400).json({ error: 'user is required' }); return; }
      const max = Math.max(1, Math.min(200, Number(req.body?.max) || 50));
      const format = req.body?.format ? String(req.body.format).trim() : undefined;
      const { found, results } = await scoutUserReplays(user, store, { max, force: !!req.body?.force, format });
      store.save();
      const output = await writeOutputs(store, config.xlsxPath);
      res.json({
        user,
        found,
        results: results.map((r) => ({
          id: r.id,
          skipped: r.skipped,
          error: r.error,
          stats: r.stats,
          scouted: r.scouted ? serialize(r.scouted) : undefined,
        })),
        output,
      });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

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
