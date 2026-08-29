// Thin wrappers over @pkmn/dex + @pkmn/data for species resolution and
// per-generation move legality. Works for every generation / format.
import { Dex } from '@pkmn/dex';
import { Generations, type Generation } from '@pkmn/data';

const gens = new Generations(Dex);
const genCache = new Map<number, Generation>();

export function getGen(num: number): Generation {
  let g = genCache.get(num);
  if (!g) {
    g = gens.get(num);
    genCache.set(num, g);
  }
  return g;
}

/** Parse the gen number out of a formatid like "gen8uu" or "gen9ou". */
export function genFromFormatId(formatid: string): number {
  const m = /^gen(\d)/.exec(formatid);
  return m ? Number(m[1]) : 9;
}

export function toID(s: string): string {
  return ('' + s).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * Resolve a species name as seen in a replay (possibly a cosmetic or
 * battle-only forme, e.g. "Zarude-Dada", "Aegislash-Blade") to the name used
 * by the sets data + learnsets (its baseSpecies where the forme is cosmetic or
 * battle-only, otherwise the forme's own name).
 */
export interface ResolvedForme {
  display: string;
  setKey: string;
  /** An item the forme is locked to (Zacian-Crowned -> Rusted Sword). */
  forcedItem?: string;
}

export function resolveSpecies(gen: Generation, name: string): ResolvedForme {
  // Team preview hides some formes as "Zacian-*"; strip the placeholder.
  const cleaned = name.replace(/-\*$/, '');
  const sp = gen.species.get(cleaned);
  if (!sp) return { display: cleaned, setKey: cleaned };

  const battleOnly = (sp as any).battleOnly;
  const requiredItem = (sp as any).requiredItem as string | undefined;
  const forme = sp.forme || '';
  const isMegaPrimal = /^Mega/.test(forme) || forme === 'Primal';
  if (battleOnly) {
    // Item-locked permanent formes (Zacian-Crowned, Zamazenta-Crowned) are BUILT
    // as the forme holding their required item — keep them, don't revert.
    if (requiredItem && !isMegaPrimal) {
      return { display: sp.name, setKey: sp.name, forcedItem: requiredItem };
    }
    // Mid-battle stances (Aegislash-Blade, Palafin-Hero, Mimikyu-Busted) and
    // Megas/Primals build as their base form.
    const base = Array.isArray(battleOnly) ? battleOnly[0]! : battleOnly;
    return { display: base, setKey: base };
  }

  if (!sp.baseSpecies || sp.baseSpecies === sp.name) {
    return { display: sp.name, setKey: sp.name };
  }

  // Cosmetic formes (Zarude-Dada, Keldeo-Resolute, Gastrodon-East, Genesect-*)
  // share the base species' stats + typing and use the base's sets/learnset.
  // We keep the forme as the DISPLAY name but key data lookups to the base.
  const base = gen.species.get(sp.baseSpecies);
  const cosmeticList = (base as any)?.cosmeticFormes as string[] | undefined;
  const listed = Array.isArray(cosmeticList) && cosmeticList.includes(sp.name);
  const identical = !!base && statsEqual(sp.baseStats as any, base.baseStats as any) && typesEqual(sp.types, base.types);
  if (listed || identical) {
    return { display: sp.name, setKey: sp.baseSpecies };
  }
  return { display: sp.name, setKey: sp.name };
}

function statsEqual(a: Record<string, number>, b: Record<string, number>): boolean {
  return (['hp', 'atk', 'def', 'spa', 'spd', 'spe'] as const).every((k) => a[k] === b[k]);
}

function typesEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && [...a].sort().join() === [...b].sort().join();
}

/**
 * Roster grouping key: the base-species id, so a mon's preview placeholder
 * ("Zacian-*") and its revealed forme ("Zacian-Crowned") land in the same slot.
 */
export function familyKey(gen: Generation, name: string): string {
  const cleaned = name.replace(/-\*$/, '');
  const sp = gen.species.get(cleaned);
  return toID(sp ? sp.baseSpecies || sp.name : cleaned);
}

/** True if `setKey` names a non-base forme (Zacian-Crowned, Landorus-Therian). */
export function isForme(gen: Generation, setKey: string): boolean {
  const sp = gen.species.get(setKey);
  return !!(sp && sp.baseSpecies && sp.baseSpecies !== sp.name);
}

export interface SpeciesMeta {
  num: number;
  types: string[];
  baseSpecies: string;
  forme: string;
}

/**
 * Types/dex-number/forme info for a species, even one the CURRENT gen's
 * regional dex doesn't carry — @pkmn/dex's per-gen wrapper only includes
 * what's obtainable in that gen's home games (e.g. gen9's wrapper excludes
 * Marshadow, Ferrothorn, Primal Groudon — real National Dex Ubers staples —
 * even though the underlying species data exists), so this falls back to the
 * ungenned base Dex (which carries every species regardless of current-gen
 * availability) whenever the gen-scoped lookup comes up empty. Base
 * stats/types don't change across gens for an already-existing species, so
 * the fallback's data is exactly as correct as the gen-scoped one would be.
 */
export function speciesMeta(gen: Generation, name: string): SpeciesMeta | undefined {
  const cleaned = name.replace(/-\*$/, '');
  const sp = gen.species.get(cleaned) ?? Dex.species.get(cleaned);
  if (!sp || !sp.exists) return undefined;
  return { num: sp.num, types: [...sp.types], baseSpecies: sp.baseSpecies || sp.name, forme: sp.forme || '' };
}

/**
 * Filename slug for play.pokemonshowdown.com/sprites/gen5/<slug>.png. NOT
 * simply toID(displayName) — Showdown IDs the base species and forme
 * SEPARATELY then joins with one hyphen, which only matters when a name has
 * an internal hyphen that isn't a forme separator (Ho-Oh -> "hooh", not
 * "ho-oh") or a forme whose own name has a hyphen (Necrozma-Dusk-Mane ->
 * "necrozma-duskmane", not "necrozma-dusk-mane" or "necrozmaduskmane").
 */
export function spriteSlug(gen: Generation, name: string): string {
  const sp = gen.species.get(name.replace(/-\*$/, ''));
  if (!sp) return toID(name);
  const base = toID(sp.baseSpecies || sp.name);
  const forme = sp.baseSpecies && sp.baseSpecies !== sp.name && sp.forme ? toID(sp.forme) : '';
  return forme ? `${base}-${forme}` : base;
}

/** Human-readable move name from any id/name. */
export function moveName(gen: Generation, nameOrId: string): string {
  const m = gen.moves.get(nameOrId);
  return m ? m.name : nameOrId;
}

export function itemName(gen: Generation, nameOrId: string): string {
  const it = gen.items.get(nameOrId);
  return it ? it.name : nameOrId;
}

export function abilityName(gen: Generation, nameOrId: string): string {
  const ab = gen.abilities.get(nameOrId);
  return ab ? ab.name : nameOrId;
}

/**
 * Is `move` legal on `species` in this generation? Checks the species'
 * learnset and walks prevo chains, which is how @pkmn/data models transfers.
 */
export async function isMoveLegal(gen: Generation, species: string, move: string): Promise<boolean> {
  const moveId = toID(move);
  let sp = gen.species.get(species);
  const seen = new Set<string>();
  while (sp && !seen.has(sp.id)) {
    seen.add(sp.id);
    const ls = await gen.learnsets.get(sp.name);
    if (ls?.learnset && ls.learnset[moveId as keyof typeof ls.learnset]) return true;
    // also check baseSpecies learnset for formes
    if (sp.baseSpecies && sp.baseSpecies !== sp.name) {
      const bls = await gen.learnsets.get(sp.baseSpecies);
      if (bls?.learnset && bls.learnset[moveId as keyof typeof bls.learnset]) return true;
    }
    sp = sp.prevo ? gen.species.get(sp.prevo) : undefined;
  }
  return false;
}

/** Default competitive nature/EV fallbacks when nothing else is known. */
export function speciesBaseStats(gen: Generation, species: string): Record<string, number> | undefined {
  const sp = gen.species.get(species);
  return sp ? (sp.baseStats as unknown as Record<string, number>) : undefined;
}
