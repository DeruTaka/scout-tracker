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

/** Every real, distinct build available for `baseSpecies` — the app's own
 *  locally-derived variants (most-evidenced first), then Smogon's top usage
 *  spreads, then Smogon's dex-analysis roles. Unlike getBestKnownSet (which
 *  just returns the single most-common one), this is for callers that want
 *  to pick WHICH real set best answers a specific matchup — e.g. a mandatory
 *  pick shouldn't be locked to "most popular" when a different real,
 *  evidenced spread/Tera/item for the same species handles the actual
 *  threats better. Capped per source so this stays cheap to call. */
export async function getKnownSetVariants(
  store: Datastore,
  gen: Generation,
  formatid: string,
  baseSpecies: string,
): Promise<KnownSet[]> {
  const spId = toID(baseSpecies);
  const out: KnownSet[] = [];

  const local = store.uniqueSets
    .filter((u) => u.formatid === formatid && toID(u.baseSpecies) === spId)
    .sort((a, b) => {
      const evidenced = (u: typeof a) => (u.set.evSource !== 'default' ? 1 : 0);
      return evidenced(b) - evidenced(a) || b.count - a.count;
    });
  for (const u of local.slice(0, 4)) out.push({ set: u.set, source: 'store', localCount: u.count });

  const usageSets = await getUsageSets(gen, formatid, baseSpecies);
  for (const ds of usageSets) {
    out.push({ set: dexSetToMatchedSet(gen, baseSpecies, ds, `Smogon usage stats (${formatid}).`), source: 'usage' });
  }

  const dexSets = await getSetsForSpecies(formatid, baseSpecies);
  for (const ds of dexSets.slice(0, 4)) {
    out.push({ set: dexSetToMatchedSet(gen, baseSpecies, ds, `Smogon dex analysis (${formatid}).`), source: 'dex' });
  }

  return out;
}

function evTotal(evs: Partial<Record<string, number>> | undefined): number {
  return Object.values(evs ?? {}).reduce((s: number, v) => s + (v ?? 0), 0);
}

/**
 * Pad out a real set that's too thin to actually play — most commonly a
 * locally-scouted build whose moveset is only whatever the trainer happened
 * to reveal in one replay (1-2 moves), not a full 4-move set, or whose EVs
 * never got real damage evidence to derive a full spread from. Fills gaps
 * from the SAME species' top Smogon usage spread (falling back to dex
 * analysis), so what comes out is still a real, commonly-run build — never
 * fabricated from nothing. Already-complete sets pass through unchanged.
 */
export async function fillRealisticSet(gen: Generation, formatid: string, known: KnownSet): Promise<KnownSet> {
  const needsMoves = known.set.moves.length < 4;
  const needsSpread = evTotal(known.set.evs) < 500; // a real 508-total spread rounds down to increments of 4
  if (!needsMoves && !needsSpread) return known;

  const usageSets = await getUsageSets(gen, formatid, known.set.baseSpecies);
  const dexSets = needsMoves || needsSpread ? await getSetsForSpecies(formatid, known.set.baseSpecies) : [];
  const fallback = usageSets[0] ?? dexSets[0];
  if (!fallback) return known;

  const set = { ...known.set };
  if (needsMoves) {
    const have = new Set(set.moves.map(toID));
    const fallbackMoves = fallback.moves
      .map((m) => (Array.isArray(m) ? m[0] : m))
      .filter((m): m is string => !!m && !have.has(toID(m)));
    set.moves = [...set.moves];
    for (const m of fallbackMoves) {
      if (set.moves.length >= 4) break;
      set.moves.push(m);
      have.add(toID(m));
    }
    if (set.moves.length > set.revealedMoves.length) {
      set.notes = [...set.notes, `Filled out to a full moveset using ${known.source === 'store' ? 'this species’' : 'the'} common ${formatid} build — only ${set.revealedMoves.length} move(s) had real evidence.`];
    }
  }
  if (needsSpread && fallback.evs && evTotal(fallback.evs) >= 500) {
    set.evs = fallback.evs;
    set.nature = pickFirst(fallback.nature) || set.nature;
    if (!set.item) set.item = pickFirst(fallback.item);
    if (!set.ability) set.ability = pickFirst(fallback.ability);
    if (!set.tera) set.tera = pickFirst(fallback.teratypes);
    set.notes = [...set.notes, `Spread filled from the common ${formatid} build — no real damage evidence to derive one from.`];
  }
  return { ...known, set };
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
