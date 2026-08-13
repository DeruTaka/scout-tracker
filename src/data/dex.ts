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
export function resolveSpecies(gen: Generation, name: string): { display: string; setKey: string } {
  const sp = gen.species.get(name);
  if (!sp) return { display: name, setKey: name };

  // Battle-only formes (Aegislash-Blade, Mimikyu-Busted, Darmanitan-Zen ...)
  // revert to their base form for team-building.
  const battleOnly = (sp as any).battleOnly;
  if (battleOnly) {
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
