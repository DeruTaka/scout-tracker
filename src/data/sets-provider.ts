// Fetch + cache Smogon "dex" analysis sets for any format from the pkmn mirror.
// Endpoint: https://pkmn.github.io/smogon/data/sets/{formatid}.json
// Shape: { SpeciesName: { RoleName: { moves, ability, item, nature, evs, ... } } }
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DexSet } from '../types.js';
import { toID } from './dex.js';

const CACHE_DIR = fileURLToPath(new URL('../../data/cache/', import.meta.url));
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // refresh weekly
const memo = new Map<string, Map<string, DexSet[]>>();

interface RawSet {
  moves: (string | string[])[];
  ability?: string | string[];
  item?: string | string[];
  nature?: string | string[];
  teratypes?: string | string[];
  evs?: Record<string, number> | Record<string, number>[];
  ivs?: Record<string, number> | Record<string, number>[];
  level?: number;
}

function cachePath(formatid: string): string {
  return join(CACHE_DIR, `sets-${formatid}.json`);
}

type EvBlock = Record<string, number>;

function normalizeSets(rawByRole: Record<string, RawSet>): DexSet[] {
  const out: DexSet[] = [];
  for (const [role, raw] of Object.entries(rawByRole)) {
    const movepool: string[] = [];
    for (const slot of raw.moves ?? []) {
      if (Array.isArray(slot)) movepool.push(...slot);
      else movepool.push(slot);
    }
    // A set can list several alternative EV spreads (and parallel natures).
    // Emit one candidate DexSet per spread so damage evidence can pick.
    const evsList: (EvBlock | undefined)[] = Array.isArray(raw.evs)
      ? (raw.evs as EvBlock[]).slice(0, 3)
      : [raw.evs as EvBlock | undefined];
    const ivsList: (EvBlock | undefined)[] = Array.isArray(raw.ivs)
      ? (raw.ivs as EvBlock[])
      : [raw.ivs as EvBlock | undefined];
    const natures = Array.isArray(raw.nature) ? raw.nature : undefined;

    evsList.forEach((evs, i) => {
      out.push({
        role: evsList.length > 1 ? `${role} (spread ${i + 1})` : role,
        moves: raw.moves ?? [],
        movepool: [...new Set(movepool)],
        ability: raw.ability,
        item: raw.item,
        nature: natures ? natures[i] ?? natures[0] : raw.nature,
        teratypes: raw.teratypes,
        evs: evs as DexSet['evs'],
        ivs: (ivsList[i] ?? ivsList[0]) as DexSet['ivs'],
        level: raw.level,
      });
    });
  }
  return out;
}

async function loadRaw(formatid: string): Promise<Record<string, Record<string, RawSet>>> {
  const path = cachePath(formatid);
  if (existsSync(path)) {
    const age = Date.now() - statSync(path).mtimeMs;
    if (age < MAX_AGE_MS) {
      try {
        return JSON.parse(readFileSync(path, 'utf8'));
      } catch {
        /* fall through to refetch */
      }
    }
  }
  const url = `https://pkmn.github.io/smogon/data/sets/${formatid}.json`;
  const res = await fetch(url);
  if (!res.ok) {
    // No dex sets for this format (randoms / very niche). Cache an empty object
    // so we don't hammer the endpoint.
    if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(path, '{}');
    return {};
  }
  const text = await res.text();
  let json: Record<string, Record<string, RawSet>>;
  try {
    if (text.trimStart().startsWith('<')) throw new Error('html');
    json = JSON.parse(text);
  } catch {
    // Transient (HTML / rate-limit page). Degrade to no dex sets, but DON'T cache
    // it — a bad response shouldn't wedge this format as empty for a week.
    return {};
  }
  if (!existsSync(CACHE_DIR)) mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(json));
  return json;
}

/** All dex sets for a format, keyed by species name (and lowercased id alias). */
export async function getSets(formatid: string): Promise<Map<string, DexSet[]>> {
  const cached = memo.get(formatid);
  if (cached) return cached;
  const raw = await loadRaw(formatid);
  const map = new Map<string, DexSet[]>();
  for (const [species, byRole] of Object.entries(raw)) {
    const sets = normalizeSets(byRole);
    map.set(species, sets);
    map.set(toID(species), sets); // id alias for tolerant lookup
  }
  memo.set(formatid, map);
  return map;
}

/** Dex sets for one species in a format (empty array if none / no data). */
export async function getSetsForSpecies(formatid: string, setKey: string): Promise<DexSet[]> {
  const map = await getSets(formatid);
  return map.get(setKey) ?? map.get(toID(setKey)) ?? [];
}
