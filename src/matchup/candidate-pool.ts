// A real, plausible built set for any species in a format — the shared
// source of truth for both "what does this threat run" and "what can our
// counter-team actually field." Prefers the app's own scouted/derived data
// (real evidence, from any trainer) over Smogon usage stats, over Smogon's
// dex analysis sets, in that order.
import type { Generation } from '@pkmn/data';
import type { Datastore } from '../store/datastore.js';
import type { DexSet, MatchedSet } from '../types.js';
import { toID, resolveSpecies } from '../data/dex.js';
import { getUsageSets, getAllUsageSpecies } from '../data/usage-provider.js';
import { getSetsForSpecies } from '../data/sets-provider.js';

function pickFirst(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/** Turn a Smogon DexSet (usage-stats or dex-analysis) into a standalone
 *  MatchedSet — no observed evidence, just "this is a real, commonly-run
 *  build for this species." */
function dexSetToMatchedSet(gen: Generation, baseSpecies: string, ds: DexSet, note: string): MatchedSet {
  const { display, setKey } = resolveSpecies(gen, baseSpecies);
  const moves = ds.moves
    .slice(0, 4)
    .map((m) => (Array.isArray(m) ? m[0] : m))
    .filter((m): m is string => !!m);
  return {
    species: display,
    baseSpecies: setKey,
    level: ds.level || 100,
    shiny: false,
    matchedRole: ds.role,
    moves,
    revealedMoves: [...moves],
    item: pickFirst(ds.item),
    itemRevealed: false,
    ability: pickFirst(ds.ability),
    nature: pickFirst(ds.nature) || 'Serious',
    evs: ds.evs || {},
    ivs: ds.ivs,
    tera: pickFirst(ds.teratypes),
    confidence: 0.6,
    notes: [note],
    evSource: 'dex-set',
    choicePossible: true,
  };
}

export type KnownSetSource = 'store' | 'usage' | 'dex';

export interface KnownSet {
  set: MatchedSet;
  source: KnownSetSource;
  /** Summed local sighting count across every distinct build stored for this
   *  species (source 'store' only) — how many real scouted games actually
   *  used it, as opposed to a single one-off sighting. */
  localCount?: number;
}

/** The single best real build available for `baseSpecies` in `formatid`:
 *  the app's own most-evidenced derived set for it (across every trainer
 *  scouted, not just one), falling back to Smogon usage stats, then Smogon's
 *  dex analysis. Returns null if nothing is known about this species at all. */
export async function getBestKnownSet(
  store: Datastore,
  gen: Generation,
  formatid: string,
  baseSpecies: string,
): Promise<KnownSet | null> {
  const spId = toID(baseSpecies);
  const local = store.uniqueSets
    .filter((u) => u.formatid === formatid && toID(u.baseSpecies) === spId)
    .sort((a, b) => {
      const evidenced = (u: typeof a) => (u.set.evSource !== 'default' ? 1 : 0);
      return evidenced(b) - evidenced(a) || b.count - a.count;
    });
  if (local.length) {
    const localCount = local.reduce((s, u) => s + u.count, 0);
    return { set: local[0]!.set, source: 'store', localCount };
  }

  const usageSets = await getUsageSets(gen, formatid, baseSpecies);
  if (usageSets.length) {
    return { set: dexSetToMatchedSet(gen, baseSpecies, usageSets[0]!, `Smogon usage stats (${formatid}) — not locally scouted.`), source: 'usage' };
  }

  const dexSets = await getSetsForSpecies(formatid, baseSpecies);
  if (dexSets.length) {
    return { set: dexSetToMatchedSet(gen, baseSpecies, dexSets[0]!, `Smogon dex analysis (${formatid}) — not locally scouted.`), source: 'dex' };
  }

  return null;
}

/** Every base species with at least one usable set for this format: the
 *  app's own scouted species, unioned with everything Smogon tracked usage
 *  for (one cached fetch) — the candidate pool the team-builder searches. */
export async function allCandidateSpecies(store: Datastore, formatid: string): Promise<string[]> {
  const ids = new Set<string>();
  const display = new Map<string, string>();
  for (const u of store.uniqueSets) {
    if (u.formatid !== formatid) continue;
    const id = toID(u.baseSpecies);
    ids.add(id);
    if (!display.has(id)) display.set(id, u.baseSpecies);
  }
  for (const species of await getAllUsageSpecies(formatid)) {
    const id = toID(species);
    ids.add(id);
    if (!display.has(id)) display.set(id, species);
  }
  return [...ids].map((id) => display.get(id)!);
}
