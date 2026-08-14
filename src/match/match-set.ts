// Match a Pokemon's revealed info against the format's dex sets and merge them
// into a best-guess full set. Revealed facts always win; the closest dex set
// fills the gaps (extra moves, item, ability, nature, EVs, tera).
import type { Generation } from '@pkmn/data';
import type { DexSet, MatchedSet, RevealedMon } from '../types.js';
import { toID, speciesBaseStats } from '../data/dex.js';

function pickFirst(v: string | string[] | undefined): string | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Would this item have announced itself in the replay log if the mon held it?
 * If so and it wasn't revealed, the mon simply isn't holding it — never fill or
 * infer one from usage/dex priors, or we'd invent an item that was visible.
 *   - Air Balloon posts an |-item| on switch-in.
 *   - Life Orb deals recoil (|-damage| [from] item: Life Orb) on every damaging
 *     hit, unless the holder has Magic Guard (recoil suppressed).
 */
export function itemWouldReveal(item: string | undefined, ability: string | undefined): boolean {
  if (!item) return false;
  const id = toID(item);
  if (id === 'airballoon') return true;
  if (id === 'lifeorb') return toID(ability || '') !== 'magicguard';
  return false;
}

/** Pick a prior item to fill an unrevealed slot, skipping self-revealing ones. */
function fillItem(item: string | string[] | undefined, ability: string | undefined): string | undefined {
  if (item === undefined) return undefined;
  const options = Array.isArray(item) ? item : [item];
  return options.find((o) => !itemWouldReveal(o, ability));
}

function idSet(names: string[]): Set<string> {
  return new Set(names.map(toID));
}

/** Score how well a dex set explains the revealed facts (higher = better). */
function scoreSet(mon: RevealedMon, set: DexSet): number {
  const pool = idSet(set.movepool);
  let score = 0;
  for (const mv of mon.moves) {
    if (pool.has(toID(mv))) score += 1;
    else score -= 0.75; // revealed move this set can't have -> evidence against
  }
  if (mon.item && set.item) {
    const items = (Array.isArray(set.item) ? set.item : [set.item]).map(toID);
    score += items.includes(toID(mon.item)) ? 0.6 : -0.4;
  }
  if (mon.ability && set.ability) {
    const abils = (Array.isArray(set.ability) ? set.ability : [set.ability]).map(toID);
    score += abils.includes(toID(mon.ability)) ? 0.5 : -0.3;
  }
  if (mon.tera && set.teratypes) {
    const teras = (Array.isArray(set.teratypes) ? set.teratypes : [set.teratypes]).map(toID);
    score += teras.includes(toID(mon.tera)) ? 0.4 : -0.1;
  }
  return score;
}

function chooseBest(mon: RevealedMon, sets: DexSet[]): DexSet | undefined {
  if (sets.length === 0) return undefined;
  let best = sets[0]!;
  let bestScore = -Infinity;
  for (const set of sets) {
    const s = scoreSet(mon, set);
    if (s > bestScore) {
      bestScore = s;
      best = set;
    }
  }
  return best;
}

/** Fill up to 4 moves: revealed moves first, then the matched set's slots. */
function buildMoves(mon: RevealedMon, set: DexSet | undefined): string[] {
  const final: string[] = [];
  const have = new Set<string>();
  const add = (name: string) => {
    const id = toID(name);
    if (id && !have.has(id) && final.length < 4) {
      have.add(id);
      final.push(name);
    }
  };
  for (const mv of mon.moves) add(mv);
  if (set) {
    for (const slot of set.moves) {
      if (final.length >= 4) break;
      const options = Array.isArray(slot) ? slot : [slot];
      const pick = options.find((o) => !have.has(toID(o))) ?? options[0];
      if (pick) add(pick);
    }
    // still short? draw from the broader movepool
    for (const mv of set.movepool) {
      if (final.length >= 4) break;
      add(mv);
    }
  }
  return final;
}

function defaultSpread(gen: Generation, mon: RevealedMon): { nature: string; evs: MatchedSet['evs'] } {
  // Prefer the categories of the revealed damaging moves; fall back to base stats.
  let phys = 0;
  let spec = 0;
  for (const mv of mon.moves) {
    const cat = gen.moves.get(mv)?.category;
    if (cat === 'Physical') phys++;
    else if (cat === 'Special') spec++;
  }
  let physical: boolean;
  if (phys !== spec) physical = phys > spec;
  else {
    const bs = speciesBaseStats(gen, mon.baseSpecies);
    physical = !bs || (bs.atk ?? 0) >= (bs.spa ?? 0);
  }
  return physical
    ? { nature: 'Adamant', evs: { atk: 252, spe: 252, hp: 4 } }
    : { nature: 'Modest', evs: { spa: 252, spe: 252, hp: 4 } };
}

/** Build a full MatchedSet for `mon` using one specific dex set (or none). */
export function buildMatched(gen: Generation, mon: RevealedMon, best: DexSet | undefined): MatchedSet {
  const notes: string[] = [];
  // Only complete the moveset from a dex set when we have 3+ revealed moves that
  // actually line up with that set — otherwise dex-filling invents nonsensical
  // move combinations. EVs / item / ability are still inferred either way.
  const revealedDistinct = new Set(mon.moves.map(toID)).size;
  const fillMoves = revealedDistinct >= 3 && revealedLinesUp(mon, best);
  const moves = fillMoves ? buildMoves(mon, best) : dedupeRevealed(mon.moves);
  if (!fillMoves && best) {
    notes.push('Moves shown are only those revealed in game (need 3+ revealed moves matching a dex set to complete the moveset).');
  }

  const ability = mon.ability ?? pickFirst(best?.ability);
  const itemRevealed = !!mon.item;
  const item = mon.item ?? fillItem(best?.item, ability);
  if (!itemRevealed && best?.item && item === undefined) {
    notes.push('Prior item was self-revealing (e.g. Air Balloon / Life Orb) but never shown — left blank.');
  }
  const tera = mon.tera ?? (gen.num >= 9 ? pickFirst(best?.teratypes) : undefined);

  let nature: string;
  let evs: MatchedSet['evs'];
  let ivs: MatchedSet['ivs'];
  let evSource: MatchedSet['evSource'];
  if (best?.evs) {
    nature = pickFirst(best.nature) ?? 'Serious';
    evs = { ...best.evs };
    ivs = best.ivs ? { ...best.ivs } : undefined;
    evSource = 'dex-set';
  } else {
    const d = defaultSpread(gen, mon);
    nature = d.nature;
    evs = d.evs;
    evSource = 'default';
    notes.push('No dex set for this Pokemon in this format; using revealed moves + a generic spread.');
  }

  if (best?.role) notes.push(`Matched dex set: "${best.role}".`);
  const unmatchedRevealed = mon.moves.filter(
    (m) => best && !new Set(best.movepool.map(toID)).has(toID(m)),
  );
  if (best && unmatchedRevealed.length) {
    notes.push(`Revealed move(s) not in the matched dex set: ${unmatchedRevealed.join(', ')}.`);
  }

  // Confidence: how much of the (up to 4) final moves were actually observed,
  // nudged by item/ability confirmation and whether we had a dex set at all.
  const revealedCount = mon.moves.length;
  let confidence = 0.25 + 0.14 * Math.min(revealedCount, 4);
  if (best) confidence += 0.05;
  if (mon.item) confidence += 0.05;
  if (mon.ability) confidence += 0.05;
  confidence = Math.min(confidence, 0.98);

  return {
    species: mon.species,
    baseSpecies: mon.baseSpecies,
    nickname: mon.nickname,
    gender: mon.gender,
    level: mon.level || best?.level || 100,
    shiny: mon.shiny,
    matchedRole: best?.role,
    moves,
    revealedMoves: [...mon.moves],
    item,
    itemRevealed,
    ability,
    nature,
    evs,
    ivs,
    tera,
    confidence,
    notes,
    evSource,
  };
}

/**
 * A mon that never switched into battle (team-preview only). There is genuinely
 * no evidence to build a set from, so any guess would be a hallucination — we
 * emit an empty, clearly-flagged set. Mons that DID appear keep their EV/item
 * predictions (calibrated from damage) even when few moves were revealed.
 */
export function isUnrevealed(mon: RevealedMon): boolean {
  return !mon.appeared;
}

/** Distinct revealed moves this set is allowed to fill toward 4. */
function dedupeRevealed(moves: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of moves) {
    const id = toID(m);
    if (id && !seen.has(id) && out.length < 4) {
      seen.add(id);
      out.push(m);
    }
  }
  return out;
}

/** Does every revealed move belong to this set's movepool (i.e. it "lines up")? */
function revealedLinesUp(mon: RevealedMon, set: DexSet | undefined): boolean {
  if (!set) return false;
  const pool = idSet(set.movepool);
  return mon.moves.length > 0 && mon.moves.every((m) => pool.has(toID(m)));
}

/** An empty placeholder set for a mon that revealed nothing in the replay. */
export function buildUnrevealed(mon: RevealedMon): MatchedSet {
  return {
    species: mon.species,
    baseSpecies: mon.baseSpecies,
    nickname: mon.nickname,
    gender: mon.gender,
    level: mon.level || 100,
    shiny: mon.shiny,
    matchedRole: undefined,
    moves: [],
    revealedMoves: [],
    item: undefined,
    itemRevealed: false,
    ability: undefined,
    nature: '',
    evs: {},
    ivs: undefined,
    tera: undefined,
    confidence: 0,
    notes: ['Never revealed in the replay — no set data to infer from.'],
    evSource: 'default',
    unrevealed: true,
  };
}

/** The reveal-scored single best match (ignores damage evidence). */
export function matchSet(gen: Generation, mon: RevealedMon, candidateSets: DexSet[]): MatchedSet {
  if (isUnrevealed(mon)) return buildUnrevealed(mon);
  return buildMatched(gen, mon, chooseBest(mon, candidateSets));
}

/**
 * All candidate MatchedSets for `mon`, ranked by reveal score (best first). The
 * damage-based selector picks among these; the first is the reveal-only pick.
 * When there are no dex sets, returns a single default/revealed-only set.
 */
export function candidateMatchedSets(
  gen: Generation,
  mon: RevealedMon,
  candidateSets: DexSet[],
): MatchedSet[] {
  if (isUnrevealed(mon)) return [buildUnrevealed(mon)];
  if (candidateSets.length === 0) return [buildMatched(gen, mon, undefined)];
  const ranked = [...candidateSets].sort((a, b) => scoreSet(mon, b) - scoreSet(mon, a));
  return ranked.map((s) => buildMatched(gen, mon, s));
}
