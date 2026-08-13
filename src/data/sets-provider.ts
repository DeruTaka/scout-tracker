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
  evs?: Record<string, number>;
  ivs?: Record<string, number>;
  level?: number;
}

function cachePath(formatid: string): string {
  return join(CACHE_DIR, `sets-${formatid}.json`);
}

function normalizeSets(rawByRole: Record<string, RawSet>): DexSet[] {
  const out: DexSet[] = [];
  for (const [role, raw] of Object.entries(rawByRole)) {
    const movepool: string[] = [];
    for (const slot of raw.moves ?? []) {
      if (Array.isArray(slot)) movepool.push(...slot);
      else movepool.push(slot);
    }
    out.push({
      role,
      moves: raw.moves ?? [],
      movepool: [...new Set(movepool)],
      ability: raw.ability,
      item: raw.item,
      nature: raw.nature,
      teratypes: raw.teratypes,
      evs: raw.evs as DexSet['evs'],
      ivs: raw.ivs as DexSet['ivs'],
      level: raw.level,
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
  const json = (await res.json()) as Record<string, Record<string, RawSet>>;
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
