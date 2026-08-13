// Fetch replays from replay.pokemonshowdown.com. Accepts a full URL or a bare
// replay id, and can list every public replay for a user.
import type { Replay } from '../types.js';
import { genFromFormatId } from '../data/dex.js';

const BASE = 'https://replay.pokemonshowdown.com';

/** Extract a replay id from a URL or return the input if it already is one. */
export function normalizeReplayId(input: string): string {
  const trimmed = input.trim();
  const m = /replay\.pokemonshowdown\.com\/([A-Za-z0-9-]+)/.exec(trimmed);
  let id = m ? m[1]! : trimmed;
  id = id.replace(/\.(json|log)$/i, '');
  id = id.replace(/\?.*$/, '');
  return id;
}

interface RawReplay {
  id: string;
  format: string;
  formatid?: string;
  players: string[];
  log: string;
  uploadtime: number;
}

function deriveWinner(log: string): string | undefined {
  const m = /\|win\|([^\n|]+)/.exec(log);
  return m ? m[1]!.trim() : undefined;
}

function formatIdFromFormat(format: string): string {
  return format.toLowerCase().replace(/[^a-z0-9]+/g, '').replace(/^gen/, 'gen');
}

/** Fetch and normalize a single replay by URL or id. */
export async function fetchReplay(input: string): Promise<Replay> {
  const id = normalizeReplayId(input);
  const url = `${BASE}/${id}`;
  const res = await fetch(`${url}.json`);
  if (!res.ok) throw new Error(`Failed to fetch replay ${id}: HTTP ${res.status}`);
  const raw = (await res.json()) as RawReplay;
  const formatid = raw.formatid || formatIdFromFormat(raw.format);
  return {
    id: raw.id || id,
    url,
    format: raw.format,
    formatid,
    gen: genFromFormatId(formatid),
    players: raw.players,
    log: raw.log,
    uploadtime: raw.uploadtime,
    winner: deriveWinner(raw.log),
  };
}

interface SearchEntry {
  id: string;
  format: string;
  players: string[];
  uploadtime: number;
}

/**
 * List a user's public replays (most recent first). The search endpoint is
 * paginated; we walk pages until exhausted or `max` is reached.
 */
export async function listUserReplays(user: string, max = 50): Promise<string[]> {
  const userid = user.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const ids: string[] = [];
  for (let page = 1; ids.length < max && page <= 25; page++) {
    const res = await fetch(`${BASE}/search.json?user=${encodeURIComponent(userid)}&page=${page}`);
    if (!res.ok) break;
    const entries = (await res.json()) as SearchEntry[];
    if (!Array.isArray(entries) || entries.length === 0) break;
    for (const e of entries) ids.push(e.id);
    if (entries.length < 51) break; // last page
  }
  return ids.slice(0, max);
}
