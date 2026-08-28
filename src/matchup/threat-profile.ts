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

interface Digest {
  player?: string;
  formatid?: string;
  threats: RawThreat[];
}

/** Parse a per-trainer scouting digest: an optional "Player (formatid):"
 *  header, then repeated paragraphs of exactly [roster line ending in ":",
 *  replay URL] — the per-mon detail paragraphs between them are informational
 *  and not yet used for weighting. Returns null if no roster/URL pairs are
 *  found (i.e. this isn't that shape of paste). */
export function parseScoutingDigest(text: string): Digest | null {
  const paragraphs = text
    .split(/\n\s*\n+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (!paragraphs.length) return null;

  let player: string | undefined;
  let formatid: string | undefined;
  const rosters: string[][] = [];

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
    if (lines.length === 2 && URL_RE.test(lines[1]!) && lines[0]!.endsWith(':')) {
      const roster = lines[0]!
        .slice(0, -1)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (roster.length) rosters.push(roster);
      continue;
    }
    // Per-mon detail paragraph (species + ability/item/moves) — not a
    // roster/URL pair, skip for weighting purposes.
  }

  if (!rosters.length) return null;

  const counts = new Map<string, { display: string; n: number }>();
  for (const roster of rosters) {
    for (const species of roster) {
      const key = species.toLowerCase();
      const cur = counts.get(key);
      if (cur) cur.n++;
      else counts.set(key, { display: species, n: 1 });
    }
  }
  const threats: RawThreat[] = [...counts.values()].map((c) => ({
    species: c.display,
    weight: (c.n / rosters.length) * 100,
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
