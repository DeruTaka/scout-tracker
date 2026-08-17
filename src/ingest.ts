// Shared ingest + output service used by both the CLI and the web UI.
import type { Datastore } from './store/datastore.js';
import type { ScoutedReplay } from './types.js';
import { fetchReplay, normalizeReplayId, listUserReplays } from './replay/fetch.js';
import { scoutReplay } from './scout.js';
import { aggregateAffectedGroups } from './ev/aggregate.js';
import { writeXlsx } from './sheet/xlsx.js';
import { googleConfigFromEnv, writeGoogleSheet } from './sheet/google-sheets.js';

export interface IngestResult {
  id: string;
  scouted?: ScoutedReplay;
  skipped?: boolean;
  error?: string;
  stats?: {
    replayNew: boolean;
    newSets: number;
    updatedSets: number;
    /** How many same-team replay groups got a pooled re-derivation from this ingest. */
    teamsAggregated: number;
  };
}

/**
 * Fetch, scout (using the store's historical priors), and store each replay.
 * Re-ingesting an already-stored replay is skipped unless `force` is set. Also
 * pools damage evidence across every other stored replay of the SAME trainer +
 * exact team roster, so EVs/item aren't judged on one replay's evidence alone.
 */
export async function ingestReplays(
  inputs: string[],
  store: Datastore,
  opts: { force?: boolean } = {},
): Promise<IngestResult[]> {
  const results: IngestResult[] = [];
  for (const input of inputs) {
    const id = normalizeReplayId(input);
    try {
      if (!opts.force && store.hasReplay(id)) {
        results.push({ id, skipped: true });
        continue;
      }
      const replay = await fetchReplay(input);
      const scouted = await scoutReplay(replay, { getPriorSets: store.getPriorSets });
      const before = new Map(store.uniqueSets.map((u) => [`${u.hash}|${u.playerId}`, u.sources.length]));
      const { replayNew } = store.ingest(scouted);
      const agg = aggregateAffectedGroups(store, replay.formatid, replay.players);
      store.rebuildUniqueSets();
      let newSets = 0;
      let updatedSets = 0;
      for (const u of store.uniqueSets) {
        const k = `${u.hash}|${u.playerId}`;
        const prevSources = before.get(k);
        if (prevSources === undefined) newSets++;
        else if (u.sources.length > prevSources) updatedSets++;
      }
      results.push({
        id: replay.id,
        scouted,
        stats: { replayNew, newSets, updatedSets, teamsAggregated: agg.groups },
      });
    } catch (e) {
      results.push({ id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return results;
}

/** Scout a replay WITHOUT storing it (manual / preview mode). */
export async function previewReplay(input: string, store?: Datastore): Promise<ScoutedReplay> {
  const replay = await fetchReplay(input);
  return scoutReplay(replay, store ? { getPriorSets: store.getPriorSets } : {});
}

export interface ScoutUserResult {
  user: string;
  found: number;
  results: IngestResult[];
}

/**
 * Pull every public replay for a trainer directly from
 * replay.pokemonshowdown.com and ingest each one (skipping already-stored
 * replays unless `force`). Shared by the CLI's `scout user` and the web UI's
 * "scout a trainer" flow. Ingested replays automatically feed the existing
 * priors/aggregation pipeline for every future calculation involving them.
 */
export async function scoutUserReplays(
  user: string,
  store: Datastore,
  opts: { max?: number; force?: boolean } = {},
): Promise<ScoutUserResult> {
  const ids = await listUserReplays(user, opts.max ?? 50);
  const results = await ingestReplays(ids, store, { force: opts.force });
  return { user, found: ids.length, results };
}

export interface OutputResult {
  xlsxPath: string;
  sheetUrl?: string;
  sheetError?: string;
}

/** Rebuild the .xlsx mirror and (if configured) the Google Sheet. */
export async function writeOutputs(store: Datastore, xlsxPath: string): Promise<OutputResult> {
  await writeXlsx(store, xlsxPath);
  const out: OutputResult = { xlsxPath };
  const g = googleConfigFromEnv();
  if (g) {
    try {
      out.sheetUrl = await writeGoogleSheet(store, g);
    } catch (e) {
      out.sheetError = e instanceof Error ? e.message : String(e);
    }
  }
  return out;
}
