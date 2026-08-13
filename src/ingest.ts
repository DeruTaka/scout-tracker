// Shared ingest + output service used by both the CLI and the web UI.
import type { Datastore } from './store/datastore.js';
import type { ScoutedReplay } from './types.js';
import { fetchReplay, normalizeReplayId } from './replay/fetch.js';
import { scoutReplay } from './scout.js';
import { writeXlsx } from './sheet/xlsx.js';
import { googleConfigFromEnv, writeGoogleSheet } from './sheet/google-sheets.js';

export interface IngestResult {
  id: string;
  scouted?: ScoutedReplay;
  skipped?: boolean;
  error?: string;
  stats?: { replayNew: boolean; newSets: number; updatedSets: number };
}

/**
 * Fetch, scout (using the store's historical priors), and store each replay.
 * Re-ingesting an already-stored replay is skipped unless `force` is set.
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
      const stats = store.ingest(scouted);
      results.push({ id: replay.id, scouted, stats });
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
