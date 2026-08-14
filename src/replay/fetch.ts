// Fetch replays from replay.pokemonshowdown.com. Accepts a full URL or a bare
// replay id, and can list every public replay for a user.
import type { Replay } from '../types.js';
import { genFromFormatId } from '../data/dex.js';

const BASE = 'https://replay.pokemonshowdown.com';

/**
 * Fetch JSON, but fail loudly-and-clearly when the server returns HTML instead
 * (a 404 page, a Cloudflare/rate-limit challenge, etc.) rather than throwing the
 * opaque "Unexpected token '<'" that a blind res.json() produces. Returns the
 * parsed body, or throws an Error with a human-readable reason.
 */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url: string, retries = 2): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url);
    // Rate-limits (429) and transient server errors (5xx) are worth retrying —
    // large batches hit these — but a 404 (missing/private replay) is not.
    if (res.status === 429 || res.status >= 500) {
      if (attempt < retries) {
        await sleep(600 * (attempt + 1));
        continue;
      }
      throw new Error(`HTTP ${res.status} (rate-limited or server error after ${retries + 1} tries)`);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (text.trimStart().startsWith('<')) {
      // A challenge / rate-limit page can come back as 200 HTML — retry those too.
      if (attempt < retries) {
        await sleep(600 * (attempt + 1));
        continue;
      }
      throw new Error('server returned HTML, not JSON (likely rate-limited or the replay is missing/private)');
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error('response was not valid JSON');
    }
  }
}

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
  let raw: RawReplay;
  try {
    raw = (await fetchJson(`${url}.json`)) as RawReplay;
  } catch (e) {
    throw new Error(`Failed to fetch replay ${id}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!raw || !raw.log) throw new Error(`Failed to fetch replay ${id}: no battle log in response`);
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
    let entries: SearchEntry[];
    try {
      entries = (await fetchJson(`${BASE}/search.json?user=${encodeURIComponent(userid)}&page=${page}`)) as SearchEntry[];
    } catch {
      break;
    }
    if (!Array.isArray(entries) || entries.length === 0) break;
    for (const e of entries) ids.push(e.id);
    if (entries.length < 51) break; // last page
  }
  return ids.slice(0, max);
}
