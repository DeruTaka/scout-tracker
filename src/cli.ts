#!/usr/bin/env -S npx tsx
// Team-Scouter CLI.
//   scout add <url|id ...>        fetch, scout, store, and write outputs
//   scout user <name> [--max N]   scout all of a user's public replays
//   scout paste <url|id>          print both team pastes (no storing)
//   scout sheet                   rebuild xlsx / Google Sheet from the store
//   scout refresh                 re-derive every stored replay with the current engine (no re-fetching)
//   scout pin <player> <formatid> pin a verified build (paste via --file/stdin)
//   scout unpin <player> <formatid> <species>   remove a pin
//   scout pins [player]           list pinned builds
//   scout serve [--port N]        start the local web UI
import { readFileSync } from 'node:fs';
import { getConfig } from './config.js';
import { Datastore } from './store/datastore.js';
import { ingestReplays, previewReplay, writeOutputs, scoutUserReplays, refreshStore } from './ingest.js';
import { startServer } from './web/server.js';
import { authorizeGoogleOAuth } from './sheet/google-sheets.js';
import { parsePasteToMatchedSet } from './build/import-set.js';
import { exportSet } from './build/pokemon-set.js';
import { getGen, genFromFormatId } from './data/dex.js';
import type { ScoutedReplay } from './types.js';

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function parseFlags(args: string[]): { positionals: string[]; flags: Record<string, string> } {
  const positionals: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else flags[key] = 'true';
    } else positionals.push(a);
  }
  return { positionals, flags };
}

function printScouted(scouted: ScoutedReplay): void {
  console.log(`\n${scouted.replay.format}  —  ${scouted.replay.players.join(' vs ')}`);
  console.log(scouted.replay.url);
  for (const team of scouted.teams) {
    console.log(`\n===== ${team.player} =====`);
    console.log(team.paste.trimEnd());
  }
}

async function main() {
  const [, , cmd, ...rest] = process.argv;
  const { positionals, flags } = parseFlags(rest);
  const config = getConfig();

  switch (cmd) {
    case 'add': {
      if (!positionals.length) return fail('Usage: scout add <url|id ...>');
      const store = new Datastore(config.storePath);
      const results = await ingestReplays(positionals, store);
      store.save();
      for (const r of results) {
        if (r.error) console.log(`✗ ${r.id}: ${r.error}`);
        else if (r.skipped) console.log(`• ${r.id}: already stored (use "sheet" to rebuild)`);
        else {
          const agg = r.stats?.teamsAggregated ? `, pooled across ${r.stats.teamsAggregated} same-team group(s)` : '';
          console.log(`✓ ${r.id}: +${r.stats?.newSets ?? 0} new sets, ${r.stats?.updatedSets ?? 0} repeats${agg}`);
          if (r.scouted) printScouted(r.scouted);
        }
      }
      await emitOutputs(store, config.xlsxPath);
      break;
    }
    case 'user': {
      const user = positionals[0];
      if (!user) return fail('Usage: scout user <name> [--max N] [--format gen9ubers]');
      const max = Number(flags.max) || 50;
      const format = flags.format;
      console.log(`Fetching up to ${max} replays for "${user}"${format ? ` in ${format}` : ''}...`);
      const store = new Datastore(config.storePath);
      const { found, results } = await scoutUserReplays(user, store, { max, format });
      console.log(`Found ${found} replays.`);
      store.save();
      const added = results.filter((r) => !r.skipped && !r.error).length;
      const skipped = results.filter((r) => r.skipped).length;
      const failed = results.filter((r) => r.error).length;
      console.log(`Ingested ${added}, skipped ${skipped}, failed ${failed}.`);
      await emitOutputs(store, config.xlsxPath);
      break;
    }
    case 'paste': {
      const url = positionals[0];
      if (!url) return fail('Usage: scout paste <url|id>');
      const store = new Datastore(config.storePath);
      printScouted(await previewReplay(url, store));
      break;
    }
    case 'sheet': {
      const store = new Datastore(config.storePath);
      await emitOutputs(store, config.xlsxPath);
      break;
    }
    case 'refresh': {
      const store = new Datastore(config.storePath);
      const total = store.replays.length;
      console.log(`Refreshing ${total} stored replays with the current engine (no network fetches)...`);
      const { errors } = await refreshStore(store, (done, tot, id) => {
        if (done % 25 === 0 || done === tot) console.log(`  ${done}/${tot} (${id})`);
      });
      store.save();
      console.log(`\nDone. ${total - errors.length}/${total} succeeded.`);
      for (const e of errors) console.log(`  ✗ ${e.id}: ${e.error}`);
      await emitOutputs(store, config.xlsxPath);
      break;
    }
    case 'pin': {
      const player = positionals[0];
      const formatid = positionals[1];
      if (!player || !formatid) {
        return fail('Usage: scout pin <player> <formatid> [--file <path>] [--note "..."]  (paste text via --file or piped stdin)');
      }
      const pasteText = flags.file ? readFileSync(flags.file, 'utf8') : await readStdin();
      if (!pasteText.trim()) return fail('No paste text provided (use --file <path> or pipe paste text via stdin).');
      try {
        const gen = getGen(genFromFormatId(formatid));
        const set = parsePasteToMatchedSet(gen, pasteText);
        const store = new Datastore(config.storePath);
        store.addPin(player, formatid, set, flags.note);
        store.save();
        console.log(`✓ Pinned ${set.species} for ${player} in ${formatid}:\n`);
        console.log(exportSet(set));
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
      break;
    }
    case 'unpin': {
      const player = positionals[0];
      const formatid = positionals[1];
      const species = positionals[2];
      if (!player || !formatid || !species) return fail('Usage: scout unpin <player> <formatid> <species>');
      const store = new Datastore(config.storePath);
      const removed = store.removePin(player, formatid, species);
      store.save();
      console.log(removed ? `✓ Removed pin for ${species} (${player}, ${formatid}).` : 'No matching pin found.');
      break;
    }
    case 'pins': {
      const store = new Datastore(config.storePath);
      const pins = store.listPins(positionals[0]);
      if (pins.length === 0) {
        console.log(positionals[0] ? `No pins for ${positionals[0]}.` : 'No pins stored.');
        break;
      }
      for (const p of pins) {
        console.log(`\n${p.player} | ${p.formatid} | pinned ${new Date(p.pinnedAt).toISOString().slice(0, 10)}${p.note ? ` | ${p.note}` : ''}`);
        console.log(exportSet(p.set));
      }
      break;
    }
    case 'auth': {
      if (positionals[0] !== 'google') return fail('Usage: scout auth google');
      try {
        const refresh = await authorizeGoogleOAuth();
        console.log('\n✓ Google authorized. Token cached to data/google-token.json.');
        console.log('\nFor a HOSTED deployment, set these env vars instead of shipping the token file:');
        console.log('  GOOGLE_OAUTH_CLIENT_ID=<from your OAuth client JSON>');
        console.log('  GOOGLE_OAUTH_CLIENT_SECRET=<from your OAuth client JSON>');
        console.log(`  GOOGLE_OAUTH_REFRESH_TOKEN=${refresh}`);
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
      break;
    }
    case 'serve': {
      const store = new Datastore(config.storePath);
      const port = Number(flags.port) || config.port;
      startServer(store, config, port);
      break;
    }
    default:
      console.log(
        'Team-Scouter\n' +
          '  scout add <url|id ...>        scout + store replays\n' +
          '  scout user <name> [--max N]   scout a user\'s replays\n' +
          '  scout paste <url|id>          print team pastes (no store)\n' +
          '  scout sheet                   rebuild xlsx / Google Sheet\n' +
          '  scout refresh                 re-derive every stored replay with the current engine (no re-fetching)\n' +
          '  scout pin <player> <fmt>      pin a verified build (paste via --file or stdin)\n' +
          '  scout unpin <player> <fmt> <species>   remove a pin\n' +
          '  scout pins [player]           list pinned builds\n' +
          '  scout auth google             authorize Google Sheets (OAuth, no key file)\n' +
          '  scout serve [--port N]        start the web UI',
      );
  }
}

async function emitOutputs(store: Datastore, xlsxPath: string) {
  const out = await writeOutputs(store, xlsxPath);
  console.log(`\nWrote ${out.xlsxPath}`);
  if (out.sheetUrl) console.log(`Google Sheet updated: ${out.sheetUrl}`);
  else if (out.sheetError) console.log(`Google Sheet skipped: ${out.sheetError}`);
  else console.log('Google Sheet not configured (set GOOGLE_APPLICATION_CREDENTIALS + SHEET_ID in .env).');
}

function fail(msg: string) {
  console.error(msg);
  process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
