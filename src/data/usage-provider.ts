// Smogon usage stats provider. Pulls the most recent month's "chaos" JSON for a
// format (https://www.smogon.com/stats/{month}/chaos/{format}-{bucket}.json) and
// turns the per-Pokemon weighted Moves / Items / Abilities / Spreads / Tera into
// (a) candidate sets the damage selector can pick from, and (b) a short usage
// summary note for reference. All network failures degrade to "no data".
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Generation } from '@pkmn/data';
import type { DexSet, StatsTable } from '../types.js';
import { moveName, itemName, abilityName, toID } from './dex.js';

const CACHE_DIR = fileURLToPath(new URL('../../data/cache/', import.meta.url));
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // monthly data is static
const RATING_BUCKETS = [1825, 1760, 1695, 1630, 1500, 0];
const TOP_MOVES = 10;
const TOP_SPREADS = 2;

interface MonUsage {
  Moves: Record<string, number>;
  Items: Record<string, number>;
  Abilities: Record<string, number>;
  Spreads: Record<string, number>;
  'Tera Types'?: Record<string, number>;
  Teammates?: Record<string, number>;
  'Raw count'?: number;
  usage: number;
}
interface Chaos {
  month: string;
  bucket: number;
  data: Record<string, MonUsage>;
}

const memo = new Map<string, Chaos | null>();
let latestMonthPromise: Promise<string | null> | null = null;

async function latestMonth(): Promise<string | null> {
  if (!latestMonthPromise) {
    latestMonthPromise = (async () => {
      try {
        const res = await fetch('https://www.smogon.com/stats/');
        if (!res.ok) return fallbackMonth();
        const html = await res.text();
        const months = [...html.matchAll(/(\d{4}-\d{2})\//g)].map((m) => m[1]!);
        return months.sort().at(-1) ?? fallbackMonth();
      } catch {
        return fallbackMonth();
      }
    })();
  }
  return latestMonthPromise;
}

function fallbackMonth(): string {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 1); // last completed month
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function pct(dict: Record<string, number>, key: string): number {
  const total = Object.values(dict).reduce((s, v) => s + v, 0) || 1;
  return ((dict[key] || 0) / total) * 100;
}
function topKeys(dict: Record<string, number> | undefined, n: number): string[] {
  if (!dict) return [];
  return Object.entries(dict)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k]) => k);
}

async function fetchChaos(formatid: string, month: string, bucket: number): Promise<Chaos | null> {
  const path = join(CACHE_DIR, `usage-${formatid}-${month}-${bucket}.json`);
  if (existsSync(path) && Date.now() - statSync(path).mtimeMs < MAX_AGE_MS) {
    try {
      return { month, bucket, data: JSON.parse(readFileSync(path, 'utf8')).data };
    } catch {
      /* refetch */
    }
  }
  const url = `https://www.smogon.com/stats/${month}/chaos/${formatid}-${bucket}.json`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const text = await res.text();
  let json: { data: Record<string, MonUsage> };
  try {
    if (text.trimStart().startsWith('<')) return null; // HTML / rate-limit page
    json = JSON.parse(text);
  } catch {
    return null;
  }
  if (!json?.data) return null;
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(path, JSON.stringify({ data: json.data }));
  return { month, bucket, data: json.data };
}

/** Load (and memoize) the best available usage bucket for a format. */
async function loadUsage(formatid: string): Promise<Chaos | null> {
  if (memo.has(formatid)) return memo.get(formatid)!;
  let result: Chaos | null = null;
  try {
    const month = await latestMonth();
    if (month) {
      for (const bucket of RATING_BUCKETS) {
        result = await fetchChaos(formatid, month, bucket);
        if (result) break;
      }
    }
  } catch {
    result = null;
  }
  memo.set(formatid, result);
  return result;
}

function lookup(chaos: Chaos, speciesName: string): MonUsage | undefined {
  if (chaos.data[speciesName]) return chaos.data[speciesName];
  const id = toID(speciesName);
  for (const [k, v] of Object.entries(chaos.data)) if (toID(k) === id) return v;
  return undefined;
}

function parseSpread(gen: Generation, spread: string): { nature: string; evs: Partial<StatsTable> } | null {
  const [nature, evStr] = spread.split(':');
  if (!nature || !evStr) return null;
  const parts = evStr.split('/').map(Number);
  if (parts.length !== 6) return null;
  const keys: (keyof StatsTable)[] = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];
  const evs: Partial<StatsTable> = {};
  keys.forEach((k, i) => {
    if (parts[i]) evs[k] = parts[i]!;
  });
  return { nature, evs };
}

function typeName(gen: Generation, id: string): string {
  const t = gen.types.get(id);
  return t ? t.name : id.charAt(0).toUpperCase() + id.slice(1);
}

/**
 * Candidate sets derived from usage stats: the top spreads combined with the
 * most-used moves / item / ability / tera. Approximate (usage is a marginal
 * distribution) but great as extra candidates for the damage selector + priors.
 */
export async function getUsageSets(gen: Generation, formatid: string, speciesName: string): Promise<DexSet[]> {
  const chaos = await loadUsage(formatid);
  if (!chaos) return [];
  const u = lookup(chaos, speciesName);
  if (!u) return [];

  const moveIds = topKeys(u.Moves, TOP_MOVES);
  const movepool = moveIds.map((m) => moveName(gen, m));
  const fixedMoves = movepool.slice(0, 4);
  const topItem = topKeys(u.Items, 1)[0];
  const topAbility = topKeys(u.Abilities, 1)[0];
  const topTera = topKeys(u['Tera Types'], 1)[0];

  const out: DexSet[] = [];
  for (const spreadKey of topKeys(u.Spreads, TOP_SPREADS)) {
    const parsed = parseSpread(gen, spreadKey);
    if (!parsed) continue;
    out.push({
      role: `Usage ${chaos.month} (${chaos.bucket}) ${pct(u.Spreads, spreadKey).toFixed(0)}%`,
      moves: fixedMoves,
      movepool,
      item: topItem ? itemName(gen, topItem) : undefined,
      ability: topAbility ? abilityName(gen, topAbility) : undefined,
      nature: parsed.nature,
      teratypes: topTera ? typeName(gen, topTera) : undefined,
      evs: parsed.evs,
    });
  }
  return out;
}

/** Every species Smogon tracked usage for in this format (one cached fetch,
 *  not a per-species call) — a broad candidate pool for the counter-team
 *  builder, supplementing whatever the app has locally scouted. */
export async function getAllUsageSpecies(formatid: string): Promise<string[]> {
  const chaos = await loadUsage(formatid);
  return chaos ? Object.keys(chaos.data) : [];
}

/** Real-metagame viability: this species' raw usage weight (roughly "fraction
 *  of teams that ran it"), 0 if untracked/unplayed. NOT a percent — Koraidon
 *  in gen9ubers is ~0.78, a never-played mon is ~0.0003 — but the relative
 *  gap between real staples and noise is exactly what a "high usage in the
 *  tier" filter needs. */
export async function getUsageWeight(formatid: string, speciesName: string): Promise<number> {
  const chaos = await loadUsage(formatid);
  if (!chaos) return 0;
  const u = lookup(chaos, speciesName);
  return u?.usage ?? 0;
}

/** How often real teams pair `speciesName` with `teammate`, as a fraction of
 *  `speciesName`'s own appearances (0..1-ish) — actual teammate co-occurrence
 *  from Smogon's stats, not a guess. 0 if either species is untracked or the
 *  pairing never appeared. */
export async function getTeammateAffinity(formatid: string, speciesName: string, teammate: string): Promise<number> {
  const chaos = await loadUsage(formatid);
  if (!chaos) return 0;
  const u = lookup(chaos, speciesName);
  const raw = u?.['Raw count'];
  const pair = u?.Teammates?.[teammate] ?? (u?.Teammates ? lookupKey(u.Teammates, teammate) : undefined);
  if (!u || !raw || pair === undefined) return 0;
  return Math.min(1, pair / raw);
}

function lookupKey(dict: Record<string, number>, name: string): number | undefined {
  if (dict[name] !== undefined) return dict[name];
  const id = toID(name);
  for (const [k, v] of Object.entries(dict)) if (toID(k) === id) return v;
  return undefined;
}

/** A short human-readable usage summary for reference (attached as a note). */
export async function getUsageSummary(gen: Generation, formatid: string, speciesName: string): Promise<string | null> {
  const chaos = await loadUsage(formatid);
  if (!chaos) return null;
  const u = lookup(chaos, speciesName);
  if (!u) return null;
  const moves = topKeys(u.Moves, 4).map((m) => `${moveName(gen, m)} ${pct(u.Moves, m).toFixed(0)}%`);
  const item = topKeys(u.Items, 1)[0];
  const tera = topKeys(u['Tera Types'], 1)[0];
  const spread = topKeys(u.Spreads, 1)[0];
  const bits = [`Usage ${chaos.month} (${chaos.bucket} bucket)`];
  if (spread) bits.push(`top spread ${spread} ${pct(u.Spreads, spread).toFixed(0)}%`);
  if (item) bits.push(`${itemName(gen, item)} ${pct(u.Items, item).toFixed(0)}%`);
  if (tera) bits.push(`Tera ${typeName(gen, tera)} ${pct(u['Tera Types'] ?? {}, tera).toFixed(0)}%`);
  bits.push(`moves: ${moves.join(', ')}`);
  return bits.join(' · ');
}
