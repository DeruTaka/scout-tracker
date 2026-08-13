// Local web UI: paste replay URLs, see both teams + importable pastes, browse
// the per-trainer unique-set library, and (re)build the sheet.
import express from 'express';
import { fileURLToPath } from 'node:url';
import type { Datastore } from '../store/datastore.js';
import type { Config } from '../config.js';
import type { ScoutedReplay } from '../types.js';
import { ingestReplays, previewReplay, writeOutputs } from '../ingest.js';
import { googleConfigFromEnv, googleAuthConfigured } from '../sheet/google-sheets.js';

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

  app.use(express.static(fileURLToPath(new URL('./public', import.meta.url))));

  app.get('/api/status', (_req, res) => {
    res.json({
      googleConfigured: !!googleConfigFromEnv() && googleAuthConfigured(),
      replays: store.replays.length,
      uniqueSets: store.uniqueSets.length,
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

  app.get('/api/unique', (req, res) => {
    const trainer = String(req.query.trainer || '').toLowerCase();
    const rows = store.uniqueSets
      .filter((u) => !trainer || u.playerId.includes(trainer))
      .sort((a, b) => a.player.localeCompare(b.player) || a.species.localeCompare(b.species) || b.count - a.count);
    res.json({ uniqueSets: rows });
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
