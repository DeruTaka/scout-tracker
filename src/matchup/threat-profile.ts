// Normalize "what does the opponent bring" into a weighted threat list, from
// either of two real-world input shapes:
//   1. A Rank/Pokemon/Use/Usage%/Win% box table (tournament stats export).
//   2. A PokePaste URL — which in practice is usually NOT a single clean
//      team export, but a per-trainer scouting digest: a header line, then
//      repeated [roster line + replay URL] pairs followed by that game's
//      per-mon partial reveals (species scouted across many of their games).
//      A standard single/multi-team paste is also supported as a fallback.
import type { Generation } from '@pkmn/data';
import { resolveSpecies } from '../data/dex.js';
import { fetchPaste, findPasteUrl } from '../replay/pokepaste-fetch.js';
import { parsePasteToTeams } from '../build/import-team.js';

export interface ThreatEntry {
  species: string; // display name as given by the input
  baseSpecies: string; // resolved key for matching against stored/dex data
  weight: number; // 0..100 relative importance
  winPercent?: number; // opponent's win% with this species, when known
  count?: number; // raw "Use"/appearance count, when known
}

export interface ThreatProfile {
  label: string;
  source: 'usage-table' | 'pokepaste-digest' | 'pokepaste-team';
  formatid?: string;
  threats: ThreatEntry[]; // sorted by weight desc
}

interface RawThreat {
  species: string;
  weight: number;
  winPercent?: number;
  count?: number;
}

function toProfile(gen: Generation, raw: RawThreat[], source: ThreatProfile['source'], label: string, formatid?: string): ThreatProfile {
  const threats = raw
    .map((r) => ({ ...r, baseSpecies: resolveSpecies(gen, r.species).setKey }))
    .sort((a, b) => b.weight - a.weight);
  return { label, source, formatid, threats };
}

// ---------------------------------------------------------------------------
// 1. Usage-stats box table.
// ---------------------------------------------------------------------------

function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map((c) => c.trim());
}

/** Parse a Rank/Pokemon/Use/Usage%/Win% box table. Tolerant of the "+----+"
 *  separator style and of column reordering (matched by header name, not
 *  position). Returns null if no recognizable header row is found. */
export function parseUsageTable(text: string): RawThreat[] | null {
  const lines = text.split('\n').filter((l) => /^\s*\|/.test(l));
  if (lines.length < 2) return null;

  let headerIdx = -1;
  let cols: { pokemon: number; use: number; usage: number; win: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const cells = splitRow(lines[i]!).map((c) => c.toLowerCase());
    const pokemon = cells.findIndex((c) => /^(pokemon|species)$/.test(c));
    if (pokemon === -1) continue;
    const use = cells.findIndex((c) => /^use$/.test(c));
    const usage = cells.findIndex((c) => /^usage/.test(c));
    const win = cells.findIndex((c) => /^win/.test(c));
    headerIdx = i;
    cols = { pokemon, use, usage, win };
    break;
  }
  if (headerIdx === -1 || !cols) return null;

  const out: RawThreat[] = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const cells = splitRow(lines[i]!);
    const species = cells[cols.pokemon];
    if (!species || !/[a-z]/i.test(species)) continue;
    const usageCell = cols.usage >= 0 ? cells[cols.usage] : undefined;
    const usagePercent = usageCell ? parseFloat(usageCell.replace('%', '')) : NaN;
    if (Number.isNaN(usagePercent)) continue;
    const winCell = cols.win >= 0 ? cells[cols.win] : undefined;
    const winPercent = winCell ? parseFloat(winCell.replace('%', '')) : undefined;
    const useCell = cols.use >= 0 ? cells[cols.use] : undefined;
    const count = useCell ? parseInt(useCell, 10) : undefined;
    out.push({
      species,
      weight: usagePercent,
      winPercent: winPercent !== undefined && !Number.isNaN(winPercent) ? winPercent : undefined,
      count: count !== undefined && !Number.isNaN(count) ? count : undefined,
    });
  }
  return out.length ? out : null;
}

// ---------------------------------------------------------------------------
// 2. Per-trainer scouting digest (repeated roster-line + replay-URL blocks).
// ---------------------------------------------------------------------------

const HEADER_RE = /^(.+?)\s*\((\w[\w\d]*)\)\s*:$/;
const URL_RE = /^https?:\/\//;
// Replay ids are monotonically increasing with real upload time
// (smogtours-gen9ubers-964153 is later than -962535) — no real per-game
// timestamp is available in a digest, but this ordering is a reliable
// recency proxy.
const REPLAY_ID_RE = /-(\d+)\s*$/;

interface Digest {
  player?: string;
  formatid?: string;
  threats: RawThreat[];
}

function extractReplayId(url: string): number | null {
  const m = REPLAY_ID_RE.exec(url.trim());
  return m ? parseInt(m[1]!, 10) : null;
}

// Recency lean: rank rosters newest-first and decay each older one's vote
// geometrically, rather than an all-or-nothing recency cutoff. A trainer's
// older games still say something real about their habits, just less than
// what they're doing right now — 0.9 per rank keeps that gentle (the 10th-
// oldest game in a typical digest still counts for ~35% of a fresh one)
// rather than nearly erasing older history.
const DIGEST_RECENCY_DECAY = 0.9;

/** Parse a per-trainer scouting digest: an optional "Player (formatid):"
 *  header, then repeated paragraphs of [roster line ending in ":", one or
 *  more replay URLs — the same roster can list several games] — the per-mon
 *  detail paragraphs between them are informational and not yet used for
 *  weighting. Returns null if no roster/URL pairs are found (i.e. this isn't
 *  that shape of paste). Each roster's vote toward a species' weight is
 *  decayed by how far back it ranks among the trainer's games here (see
 *  DIGEST_RECENCY_DECAY), not counted equally regardless of age. */
export function parseScoutingDigest(text: string): Digest | null {
  const paragraphs = text
    .split(/\n\s*\n+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (!paragraphs.length) return null;

  let player: string | undefined;
  let formatid: string | undefined;
  const rosters: { species: string[]; replayId: number | null }[] = [];

  for (const para of paragraphs) {
    const lines = para.split('\n').map((l) => l.trim());
    if (lines.length === 1) {
      const m = HEADER_RE.exec(lines[0]!);
      if (m && !player) {
        player = m[1];
        formatid = m[2];
      }
      continue;
    }
    const urlLines = lines.slice(1);
    if (lines.length >= 2 && lines[0]!.endsWith(':') && urlLines.every((l) => URL_RE.test(l))) {
      const species = lines[0]!
        .slice(0, -1)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      // A roster can list several replays of the same team — take the most
      // recent id among them as this roster's own recency.
      const ids = urlLines.map(extractReplayId).filter((n): n is number => n !== null);
      if (species.length) rosters.push({ species, replayId: ids.length ? Math.max(...ids) : null });
      continue;
    }
    // Per-mon detail paragraph (species + ability/item/moves) — not a
    // roster/URL pair, skip for weighting purposes.
  }

  if (!rosters.length) return null;

  // Rank newest-first (unknown-recency rosters sort last, treated as oldest)
  // and assign each a geometrically decaying vote weight.
  const ranked = [...rosters].sort((a, b) => (b.replayId ?? -Infinity) - (a.replayId ?? -Infinity));
  const rosterWeight = new Map<(typeof rosters)[number], number>();
  ranked.forEach((r, i) => rosterWeight.set(r, DIGEST_RECENCY_DECAY ** i));

  const totalWeight = [...rosterWeight.values()].reduce((s, w) => s + w, 0);
  const tally = new Map<string, { display: string; n: number; weight: number }>();
  for (const roster of rosters) {
    const w = rosterWeight.get(roster)!;
    for (const species of roster.species) {
      const key = species.toLowerCase();
      const cur = tally.get(key);
      if (cur) {
        cur.n++;
        cur.weight += w;
      } else {
        tally.set(key, { display: species, n: 1, weight: w });
      }
    }
  }
  const threats: RawThreat[] = [...tally.values()].map((c) => ({
    species: c.display,
    weight: (c.weight / totalWeight) * 100,
    count: c.n,
  }));
  return { player, formatid, threats };
}

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------

export interface BuildThreatProfileOptions {
  fetchPokepaste?: (url: string) => Promise<string>;
}

/** Build a ThreatProfile from raw user input — a pasted usage table, a
 *  PokePaste URL (scouting digest or standard team export), or both mixed
 *  together in one blob (the table wins if both are present, since it's the
 *  richer signal with win% data). */
export async function buildThreatProfile(
  gen: Generation,
  rawInput: string,
  opts: BuildThreatProfileOptions = {},
): Promise<ThreatProfile> {
  const table = parseUsageTable(rawInput);
  if (table && table.length >= 2) {
    return toProfile(gen, table, 'usage-table', 'Pasted usage table');
  }

  const url = findPasteUrl(rawInput);
  if (url) {
    const fetcher = opts.fetchPokepaste ?? fetchPaste;
    const text = await fetcher(url);

    const digest = parseScoutingDigest(text);
    if (digest && digest.threats.length) {
      const label = digest.player
        ? `${digest.player}'s scouted history${digest.formatid ? ` (${digest.formatid})` : ''}`
        : 'Scouted history from PokePaste';
      return toProfile(gen, digest.threats, 'pokepaste-digest', label, digest.formatid);
    }

    const teams = parsePasteToTeams(gen, text);
    if (teams.length) {
      const counts = new Map<string, { display: string; n: number }>();
      for (const team of teams) {
        for (const mon of team) {
          const key = mon.baseSpecies.toLowerCase();
          const cur = counts.get(key);
          if (cur) cur.n++;
          else counts.set(key, { display: mon.species, n: 1 });
        }
      }
      const raw: RawThreat[] = [...counts.values()].map((c) => ({ species: c.display, weight: (c.n / teams.length) * 100, count: c.n }));
      return toProfile(gen, raw, 'pokepaste-team', teams.length > 1 ? `${teams.length} teams from PokePaste` : 'Team from PokePaste');
    }

    throw new Error('Could not parse the PokePaste as either a scouted-history digest or a standard team export.');
  }

  throw new Error('Could not find a usage table or a PokePaste URL in the input.');
}
