// Derive plausible EV spreads by reconciling each matched set against the
// actual damage seen in the replay, using @smogon/calc as the oracle. Starts
// from the dex-set spread (the prior) and, only where observed damage falls
// outside the prior's predicted range, searches for the minimal-deviation
// legal spread that fits.
import * as calc from '@smogon/calc';
import type { GenerationNum } from '@pkmn/data';
type CalcGen = ReturnType<typeof calc.Generations.get>;
import type { DamageObservation, DexSet, FieldSnapshot, MatchedSet, SpeedObservation, StatsTable } from '../types.js';
import { toID } from '../data/dex.js';
import { itemWouldReveal } from '../match/match-set.js';

const TOL = 1.5; // percent-point tolerance for HP% rounding
const EV_STEP = 4;
const EV_MAX = 252;
const EV_TOTAL = 508;
// Keep the dex prior unless the summed violation exceeds this (percent points).
// Lower = damage evidence overrides usage/dex priors more readily.
const KEEP_THRESHOLD = 1.5;
// Regularization: cost (in violation-equivalent points) of moving the full 252
// EVs away from the prior. Stops the search overfitting to rounding noise.
const LAMBDA = 5;
// Extra cost for flipping the dex-set's nature; only done under strong evidence.
const NATURE_PENALTY = 6;
// Extra cost for inferring an unrevealed damage item (Choice Specs/Band, Life
// Orb). Set ABOVE the nature penalty so the search prefers a plausible nature
// (e.g. Adamant) over claiming an unrevealed item — an item is only inferred
// when it removes a violation a spread/nature change cannot.
const ITEM_PENALTY = 8;
// If even the best-fit spread can't get within this residual, the evidence
// doesn't cleanly fit any spread (likely an unrevealed item/ability) — keep the
// dex prior rather than emit a bogus spread.
const RESIDUAL_ACCEPT = 5;

export interface SideSets {
  side: 'p1' | 'p2';
  sets: MatchedSet[];
}

const OFFENSE_NATURE: Record<'atk' | 'spa', string> = { atk: 'Adamant', spa: 'Modest' };

// Unrevealed damage-boosting items to try when the spread alone can't explain a
// hit. Choice items (1.5x) don't announce themselves, so a mon whose item was
// never shown may well be holding one. Life Orb (1.3x) is only a candidate for
// Magic Guard holders — otherwise its recoil would have revealed it in the log.
const OFFENSE_ITEMS: Record<'atk' | 'spa', string[]> = {
  atk: ['Choice Band', 'Life Orb'],
  spa: ['Choice Specs', 'Life Orb'],
};

/** Inferable offensive items for this mon, dropping self-revealing ones — and
 *  Choice items when the mon provably used 2+ moves without switching. */
function offenseItemCandidates(ms: MatchedSet, stat: 'atk' | 'spa'): string[] {
  const choiceOk = ms.choicePossible !== false;
  return OFFENSE_ITEMS[stat].filter((it) => {
    if (!choiceOk && toID(it).startsWith('choice')) return false;
    return !itemWouldReveal(it, ms.ability);
  });
}

function sameItem(a: string, b: string): boolean {
  return toID(a) === toID(b);
}

function dedupeItems(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const it of items) {
    const id = toID(it);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(it);
  }
  return out;
}

function key(side: string, baseSpecies: string): string {
  return `${side}:${baseSpecies.toLowerCase()}`;
}

function mapWeather(w?: string): string | undefined {
  switch (w) {
    case 'RainDance':
    case 'Rain':
      return 'Rain';
    case 'SunnyDay':
    case 'Sun':
      return 'Sun';
    case 'Sandstorm':
    case 'Sand':
      return 'Sand';
    case 'Hail':
      return 'Hail';
    case 'Snow':
      return 'Snow';
    case 'DesolateLand':
      return 'Harsh Sunshine';
    case 'PrimordialSea':
      return 'Heavy Rain';
    case 'DeltaStream':
      return 'Strong Winds';
    default:
      return undefined;
  }
}

const STATUS_OK = new Set(['brn', 'par', 'psn', 'tox', 'slp', 'frz']);
function mapStatus(s?: string): '' | 'brn' | 'par' | 'psn' | 'tox' | 'slp' | 'frz' {
  return s && STATUS_OK.has(s) ? (s as any) : '';
}

function buildField(gen: CalcGen, snap: FieldSnapshot): calc.Field {
  return new calc.Field({
    weather: mapWeather(snap.weather) as any,
    terrain: snap.terrain as any,
    attackerSide: new calc.Side({}),
    defenderSide: new calc.Side({
      isReflect: snap.reflect,
      isLightScreen: snap.lightScreen,
      isAuroraVeil: snap.auroraVeil,
    }),
  });
}

function buildPokemon(
  gen: CalcGen,
  ms: MatchedSet,
  opts: {
    evs?: Partial<StatsTable>;
    nature?: string;
    boosts?: Partial<StatsTable>;
    status?: string;
    tera?: string;
    item?: string; // explicit override ('' = no item); undefined = use ms.item
  },
): calc.Pokemon | null {
  // Some species/formes aren't resolvable in calc's dataset for a given gen
  // (e.g. Aegislash's base forme in gen 8). Those simply skip EV derivation.
  try {
    // @smogon/calc's own gen7+ mechanics unconditionally re-apply Intrepid
    // Sword's/Dauntless Shield's +1 stage INSIDE calculate() itself
    // (checkIntrepidSword/checkDauntlessShield in its mechanics/util.js),
    // treating the ability as if it had just freshly triggered — there's no
    // way to opt out via the ability field. Our own boosts come from actually
    // tracking -boost/-unboost lines in the log (reset on switch-out like any
    // other stage), so they're already correct for whether the boost is
    // currently active. Pre-subtract 1 from whichever stat the ability
    // targets so the library's forced re-add nets out to what we observed,
    // instead of silently stacking an extra +1 on top of it.
    let boosts = opts.boosts;
    if (gen.num > 7 && (ms.ability === 'Intrepid Sword' || ms.ability === 'Dauntless Shield')) {
      const stat = ms.ability === 'Intrepid Sword' ? 'atk' : 'def';
      boosts = { ...boosts, [stat]: (boosts?.[stat] ?? 0) - 1 };
    }
    const p = new calc.Pokemon(gen, ms.baseSpecies, {
      level: ms.level,
      item: (opts.item !== undefined ? opts.item : ms.item) || undefined,
      ability: ms.ability,
      nature: opts.nature ?? ms.nature,
      evs: opts.evs ?? ms.evs,
      ivs: ms.ivs,
      boosts,
      status: mapStatus(opts.status),
      teraType: gen.num >= 9 && opts.tera ? (opts.tera as any) : undefined,
    });
    if (!p.species || !(p.species as any).baseStats) return null;
    return p;
  } catch {
    return null;
  }
}

/** Predicted damage as [minPct, maxPct] of the defender's max HP, or null. */
function predictPct(
  gen: CalcGen,
  attacker: calc.Pokemon,
  defender: calc.Pokemon,
  moveName: string,
  field: calc.Field,
): [number, number] | null {
  try {
    const move = new calc.Move(gen, moveName);
    const res = calc.calculate(gen, attacker, defender, move, field);
    const dmg = res.range();
    const max = defender.maxHP();
    if (!max) return null;
    return [(dmg[0] / max) * 100, (dmg[1] / max) * 100];
  } catch {
    return null;
  }
}

// In the offense pass an observed hit that lands SOFTER than our model predicts
// (observed below the predicted min) is confounded — it can mean the attacker
// invested less OR that the defender is bulkier than the spread we assumed. So
// it's weak evidence about the attacker and is down-weighted, whereas a hit that
// EXCEEDS our predicted max unambiguously says the attacker hits harder (needs a
// bigger spread / a Choice item) and is penalized in full. Defense keeps the
// full weight — there, a softer-than-modeled hit IS the bulk signal.
const OVERPREDICT_WEIGHT = 0.25;

function violation(observed: number, lo: number, hi: number, koCapped: boolean, underWeight = 1): number {
  // For a KO the observed % is only a LOWER bound on true damage, so we only
  // penalize UNDER-prediction (predicted max can't even reach what we saw).
  if (koCapped) return observed > hi + TOL ? observed - (hi + TOL) : 0;
  if (observed < lo - TOL) return (lo - TOL - observed) * underWeight;
  if (observed > hi + TOL) return observed - (hi + TOL);
  return 0;
}

/**
 * Distance from the AVERAGE roll, rather than "inside the roll range at
 * all". `violation()` is 0 for every EV value whose predicted range merely
 * CONTAINS the observed %, which leaves a wide plateau of equally-"valid"
 * candidates with no signal for which one is actually the best-supported
 * explanation. Damage rolls are 16 evenly-spaced values (85%-100% of base),
 * so the range's midpoint IS the expected roll — scoring against it gives
 * the search a real gradient toward "solve for the EV that makes this hit
 * an average roll", not just "any EV that doesn't contradict it".
 */
// A damage roll is 16 EQUALLY-likely values (85%-100% of base, evenly
// spaced) — so given a candidate EV value whose predicted range merely
// CONTAINS the observed %, that candidate is exactly as statistically
// consistent with the hit as any other candidate whose range also contains
// it, REGARDLESS of whether the observed % lands near the range's edge or
// its middle. There's no likelihood argument for preferring the midpoint.
// What DOES matter: a candidate that only explains the hit by landing near
// the very edge of its range is fragile — it stops working under the
// slightest error in our own assumptions (an unmodeled item, a slightly
// wrong nature guess, rounding). Preferring a candidate whose range covers
// the hit with more margin on both sides is a robustness preference, not a
// likelihood one — so it's weighted as a mild tie-break UNDER the
// deviation-from-prior cost, never enough to override it outright.
const EDGE_ROBUSTNESS_WEIGHT = 0.6;

function defenseFitDistance(observed: number, lo: number, hi: number, koCapped: boolean): number {
  const coarse = violation(observed, lo, hi, koCapped);
  if (koCapped || hi <= lo) return coarse;
  const edgeness = Math.min(1, Math.abs(observed - (lo + hi) / 2) / ((hi - lo) / 2));
  return coarse + edgeness * EDGE_ROBUSTNESS_WEIGHT;
}

const ALL_STATS: (keyof StatsTable)[] = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];
const STAT_LABEL: Record<keyof StatsTable, string> = { hp: 'HP', atk: 'Atk', def: 'Def', spa: 'SpA', spd: 'SpD', spe: 'Spe' };

/** Non-tested stats, least-invested-first — the natural "what's this build not
 *  really using" order to draw a trade from. */
// Tiebreak for donors with equal prior investment: Speed is the stat a real
// spread sacrifices first for bulk (it doesn't undercut the damage already
// evidenced elsewhere), offense stats (Atk/SpA) are sacrificed last since
// they're directly load-bearing for whatever damage output got this mon its
// prior in the first place.
const SACRIFICE_ORDER: (keyof StatsTable)[] = ['spe', 'hp', 'spd', 'def', 'spa', 'atk'];

function donorOrder(priorEvs: Partial<StatsTable>, exclude: (keyof StatsTable)[]): (keyof StatsTable)[] {
  return ALL_STATS.filter((s) => !exclude.includes(s)).sort((a, b) => {
    const diff = (priorEvs[a] || 0) - (priorEvs[b] || 0);
    return diff !== 0 ? diff : SACRIFICE_ORDER.indexOf(a) - SACRIFICE_ORDER.indexOf(b);
  });
}

/**
 * Build a full, budget-legal (508-total) EV spread: `fixed` stats take their
 * given candidate value; every other stat starts at its prior value, then
 * `donors` are drained — in order, down to their floor (default 0) — to cover
 * any overage. This is the general form of "trade EVs for bulk": ANY stat can
 * fund any other, as long as the donor isn't below a proven floor (e.g. a
 * speedFloor from turn-order evidence) and never GAINS EVs it didn't already
 * have here (donors only ever shrink). Returns null if fully draining every
 * donor still doesn't fit — genuinely infeasible, not just "unlikely".
 */
function allocateDonors(
  priorEvs: Partial<StatsTable>,
  fixed: Partial<Record<keyof StatsTable, number>>,
  donors: (keyof StatsTable)[],
  floors: Partial<Record<keyof StatsTable, number>>,
): Partial<StatsTable> | null {
  const result: Partial<StatsTable> = {};
  for (const s of ALL_STATS) result[s] = s in fixed ? fixed[s]! : priorEvs[s] || 0;
  let over = ALL_STATS.reduce((sum, s) => sum + (result[s] || 0), 0) - EV_TOTAL;
  if (over > 0) {
    for (const donor of donors) {
      if (over <= 0) break;
      const floor = floors[donor] ?? 0;
      const cur = result[donor] || 0;
      const take = Math.min(Math.max(0, cur - floor), over);
      result[donor] = cur - take;
      over -= take;
    }
  }
  return over > 0 ? null : result;
}

/** Regularization cost: total EV movement across ALL stats (including any
 *  donor reallocation), as a fraction of one stat's cap. */
function totalDeviation(evs: Partial<StatsTable>, priorEvs: Partial<StatsTable>): number {
  let dev = 0;
  for (const s of ALL_STATS) dev += Math.abs((evs[s] || 0) - (priorEvs[s] || 0));
  return dev / EV_MAX;
}

// HP is the most efficient defensive investment — it helps against BOTH
// physical and special hits at once, where Def/SpD only cover one — so a
// real mixed wall leans on HP first and only reaches for a single defense
// stat to cover what HP alone can't. Weighting HP's movement below its true
// EV cost in the joint defense search encodes that preference directly,
// rather than leaving it to be a last-resort leftover-budget fallback.
const HP_DEV_WEIGHT = 0.35;

/** Same as totalDeviation, but HP movement counts for less — used only by
 *  the joint Def+SpD search, where we WANT the regularizer to prefer HP. */
function weightedDeviation(evs: Partial<StatsTable>, priorEvs: Partial<StatsTable>): number {
  let dev = 0;
  for (const s of ALL_STATS) {
    const raw = Math.abs((evs[s] || 0) - (priorEvs[s] || 0));
    dev += s === 'hp' ? raw * HP_DEV_WEIGHT : raw;
  }
  return dev / EV_MAX;
}

/** Human-readable list of which donor stats actually moved, for a note. */
function donorNoteList(evs: Partial<StatsTable>, priorEvs: Partial<StatsTable>, donors: (keyof StatsTable)[]): string {
  return donors
    .map((d) => ({ d, delta: (priorEvs[d] || 0) - (evs[d] || 0) }))
    .filter((x) => x.delta > 0)
    .map((x) => `${x.delta} ${STAT_LABEL[x.d]}`)
    .join(', ');
}

/**
 * Refine `sets` in place. `teams` supplies the side of each set so that the
 * same species on both teams is handled correctly.
 */
/**
 * Pick the best reference EV spread out of a trainer's-history-then-common-
 * usage candidate list (the same shape `getPriorSets` already returns) for
 * Pass C to fill leftover EVs from. Prefers whichever candidate actually
 * invests in HP — the stat Pass C most often needs — falling back to any
 * candidate with SOME investment at all.
 */
export function pickReferenceEvs(sets: DexSet[]): Partial<StatsTable> | undefined {
  const withHp = sets.find((s) => (s.evs?.hp || 0) > 0);
  if (withHp?.evs) return withHp.evs;
  const withAny = sets.find((s) => s.evs && ALL_STATS.some((k) => (s.evs![k] || 0) > 0));
  return withAny?.evs;
}

export interface DeriveEvsOptions {
  /**
   * Called when Pass C needs to fill leftover EVs and wants a smarter target
   * than a blind HP max — return this trainer's (or the species' common)
   * other build for `baseSpecies`, if one with real stat investment exists.
   * Synchronous: the store-backed implementation (Datastore.getPriorSets) is
   * plain sync, and threading a Promise through the search loop isn't worth
   * it for a fallback path.
   */
  referenceEvs?: (side: 'p1' | 'p2', baseSpecies: string) => Partial<StatsTable> | undefined;
}

export function deriveEvs(
  genNum: number,
  teams: SideSets[],
  observations: DamageObservation[],
  opts: DeriveEvsOptions = {},
): void {
  // Gens 1–2 (RBY/GSC) have no EVs in the modern sense — stat experience / DVs
  // are effectively maxed, so damage-based EV derivation is meaningless. Keep
  // the dex-set spread exactly as matched, without calculating.
  if (genNum <= 2) {
    for (const t of teams) for (const s of t.sets) {
      if (!s.unrevealed) s.notes.push('Gen 1/2: EVs left at the dex spread (no EV calc).');
    }
    return;
  }
  const gen = calc.Generations.get(genNum as GenerationNum);
  const byKey = new Map<string, MatchedSet>();
  for (const t of teams) for (const s of t.sets) byKey.set(key(t.side, s.baseSpecies), s);

  const usable = observations.filter((o) => o.usable);

  // ---- Pass A: offense (attacker's Atk / SpA) ----
  const offenseByAttacker = new Map<string, DamageObservation[]>();
  for (const o of usable) {
    const k = key(o.attackerSide, o.attackerSpecies);
    (offenseByAttacker.get(k) ?? offenseByAttacker.set(k, []).get(k)!).push(o);
  }
  for (const [k, obs] of offenseByAttacker) {
    const ms = byKey.get(k);
    if (!ms) continue;
    for (const stat of ['atk', 'spa'] as const) {
      const catObs = obs.filter((o) => {
        const c = gen.moves.get(toID(o.move) as any)?.category;
        return (stat === 'atk' && c === 'Physical') || (stat === 'spa' && c === 'Special');
      });
      if (catObs.length === 0) continue;
      refineOffense(gen, ms, byKey, stat, catObs);
    }
  }

  // ---- Pass B: defense (defender's HP + Def / SpD) ----
  const defenseByDefender = new Map<string, DamageObservation[]>();
  for (const o of usable) {
    const k = key(o.defenderSide, o.defenderSpecies);
    (defenseByDefender.get(k) ?? defenseByDefender.set(k, []).get(k)!).push(o);
  }
  // Which defense category (def/spd) actually got weighed against damage
  // taken, per mon — HP is jointly optimized by EITHER, but Def/SpD are only
  // pinned individually (a mon that only ever took physical hits never had
  // its SpD evidence-checked at all, and stays free for Pass C to fill).
  const defenseTested = new Map<string, Set<'def' | 'spd'>>();
  for (const [k, obs] of defenseByDefender) {
    const ms = byKey.get(k);
    if (!ms) continue;
    const byCat: Record<'def' | 'spd', DamageObservation[]> = { def: [], spd: [] };
    for (const stat of ['def', 'spd'] as const) {
      byCat[stat] = obs.filter((o) => {
        const c = gen.moves.get(toID(o.move) as any)?.category;
        return (stat === 'def' && c === 'Physical') || (stat === 'spd' && c === 'Special');
      });
      if (byCat[stat].length > 0) {
        (defenseTested.get(k) ?? defenseTested.set(k, new Set()).get(k)!).add(stat);
      }
    }
    // Refine both together when both have evidence — see refineDefensePair's
    // doc comment for why running them independently silently discards a
    // genuinely mixed wall's split investment.
    refineDefensePair(gen, ms, byKey, byCat.def, byCat.spd);
  }

  // ---- Pass C: a lower-than-prior Atk/SpA/Def/SpD read frees EVs that a real
  // spread wouldn't just leave unspent (donor trades that INCREASE a stat
  // already re-balance to exactly 508 — see allocateDonors — so this only
  // fires on a plain decrease). Prefer filling the gap the way this trainer
  // (or common usage) actually builds this species elsewhere; fall back to a
  // blind HP max — the safest stat to pad without contradicting a fit — for
  // whatever a reference doesn't cover. Never touches Atk/SpA (pinned to this
  // run's own offensive evidence) or a stat that WAS weighed against damage
  // taken this run, even if the search chose to leave it unchanged.
  for (const [k, ms] of byKey) {
    if (ms.unrevealed || ms.evSource !== 'derived') continue;
    const total = ALL_STATS.reduce((s, stat) => s + (ms.evs[stat] || 0), 0);
    let remaining = EV_TOTAL - total;
    if (remaining <= 0) continue;
    const tested = defenseTested.get(k);
    const blocked = new Set<keyof StatsTable>(['atk', 'spa']);
    if (tested?.size) blocked.add('hp'); // hp is jointly optimized by either defense category
    if (tested?.has('def')) blocked.add('def');
    if (tested?.has('spd')) blocked.add('spd');
    const side = k.split(':')[0] as 'p1' | 'p2';
    const reference = opts.referenceEvs?.(side, ms.baseSpecies);
    const evs = { ...ms.evs };
    const filled: string[] = [];
    let fromReference = false;
    if (reference) {
      // HP first (the primary gap this pass exists to close), then whatever
      // else the reference invests in.
      for (const stat of ['hp', 'def', 'spd', 'spe'] as const) {
        if (remaining <= 0) break;
        if (blocked.has(stat)) continue;
        const refVal = reference[stat] || 0;
        const cur = evs[stat] || 0;
        if (refVal <= cur) continue; // reference doesn't suggest more here
        const add = Math.min(EV_MAX - cur, refVal - cur, Math.floor(remaining / EV_STEP) * EV_STEP);
        if (add <= 0) continue;
        evs[stat] = cur + add;
        remaining -= add;
        filled.push(`${add} ${STAT_LABEL[stat]}`);
        fromReference = true;
      }
    }
    // Blind fallback for whatever's still unaccounted for: HP first if it's
    // not blocked, then whichever untested defense stat has room. Speed is
    // DELIBERATELY excluded here (and from the two tiers below, until they've
    // both failed) — an unfounded Speed claim is a worse default than an
    // unfounded HP/bulk one for the common case (a mon that's clearly built
    // defensively has no business getting leftover EVs dumped into Speed just
    // because HP/Def/SpD each happened to have SOME evidence attached).
    const blindFilled: string[] = [];
    for (const stat of ['hp', 'def', 'spd'] as const) {
      if (remaining <= 0) break;
      if (blocked.has(stat)) continue;
      const cur = evs[stat] || 0;
      const add = Math.min(EV_MAX - cur, Math.floor(remaining / EV_STEP) * EV_STEP);
      if (add <= 0) continue;
      evs[stat] = cur + add;
      remaining -= add;
      filled.push(`${add} ${STAT_LABEL[stat]}`);
      blindFilled.push(`${add} ${STAT_LABEL[stat]}`);
    }
    // Emergency tier: hp/def/spd are all still blocked (e.g. a mon that took
    // both a physical AND special hit, each genuinely fit-searched against
    // the prior — not just passively confirmed — while a separate offense
    // read pulled Atk/SpA down hard). A real spread is ALWAYS exactly 508
    // EVs; leaving it visibly incomplete is worse than nudging a stat that
    // WAS searched, so relax that block here — but Atk/SpA remain
    // untouchable even now, and Speed is STILL not tried yet: HP/Def/SpD
    // have 3×252 EVs of headroom between them, so this tier alone covers
    // every case a real spread's remaining budget could plausibly need.
    let emergency = false;
    if (remaining > 0) {
      for (const stat of ['hp', 'def', 'spd'] as const) {
        if (remaining <= 0) break;
        const cur = evs[stat] || 0;
        const add = Math.min(EV_MAX - cur, Math.floor(remaining / EV_STEP) * EV_STEP);
        if (add <= 0) continue;
        evs[stat] = cur + add;
        remaining -= add;
        filled.push(`${add} ${STAT_LABEL[stat]}`);
        emergency = true;
      }
    }
    // Absolute last resort: HP/Def/SpD are all already maxed at 252 (rare —
    // means 756+ EVs of bulk were already justified) and there's STILL
    // budget left over. Speed is safe here in the sense that it never
    // contradicts turn-order evidence (a proven "faster than" is a lower
    // bound, not an exact pin) — it's just the worst DEFAULT guess for a
    // mon we have no positive reason to think invests in it, which is why
    // every bulk-focused tier above gets first refusal.
    if (remaining > 0) {
      const cur = evs.spe || 0;
      const add = Math.min(EV_MAX - cur, Math.floor(remaining / EV_STEP) * EV_STEP);
      if (add > 0) {
        evs.spe = cur + add;
        remaining -= add;
        filled.push(`${add} Spe`);
        emergency = true;
      }
    }
    if (filled.length === 0) continue;
    ms.evs = evs;
    let reason: string;
    if (emergency) reason = "budget didn't add up from evidence alone — nudged a passively-confirmed stat rather than leave the spread incomplete";
    else if (fromReference && blindFilled.length === 0) reason = `matched to this trainer's other ${ms.baseSpecies} builds`;
    else if (fromReference) reason = `matched to this trainer's other ${ms.baseSpecies} builds where possible, no direct evidence for the rest`;
    else reason = 'no direct evidence for this stat';
    ms.notes.push(`Filled ${filled.join(', ')} (${reason}) to reach a full ${EV_TOTAL}-EV spread.`);
  }
}

interface ViolationResult {
  v: number; // average violation (percent points) across the observations
  n: number; // how many observations that average is built from
}

function totalViolationOffense(
  gen: CalcGen,
  ms: MatchedSet,
  byKey: Map<string, MatchedSet>,
  evs: Partial<StatsTable>,
  nature: string,
  obs: DamageObservation[],
  item?: string,
): ViolationResult {
  let v = 0;
  let n = 0;
  for (const o of obs) {
    const def = byKey.get(key(o.defenderSide, o.defenderSpecies));
    if (!def) continue;
    const attacker = buildPokemon(gen, ms, {
      evs,
      nature,
      item,
      boosts: o.field.attackerBoosts,
      status: o.field.attackerStatus,
      tera: o.field.attackerTera,
    });
    const defender = buildPokemon(gen, def, {
      boosts: o.field.defenderBoosts,
      status: o.field.defenderStatus,
      tera: o.field.defenderTera,
    });
    if (!attacker || !defender) continue;
    const range = predictPct(gen, attacker, defender, o.move, buildField(gen, o.field));
    if (!range) continue;
    v += violation(o.observedPercent, range[0], range[1], o.koCapped, OVERPREDICT_WEIGHT);
    n++;
  }
  return { v: n ? v / n : 0, n }; // average per-observation, so noisy hits don't compound
}

/**
 * Confidence discount on the regularizer: one hit with a small residual is
 * cheap to dismiss as rounding noise, but the SAME average residual repeated
 * across several independent hits (more turns this replay, or pooled from
 * other replays of the same team) is much less likely to be noise and should
 * move the spread more readily. Standard 1/sqrt(n) shrinkage — n=1 leaves the
 * regularizer at full strength (today's behavior); n=4 halves it.
 */
function evidenceScale(n: number): number {
  return 1 / Math.sqrt(Math.max(n, 1));
}

function refineOffense(
  gen: CalcGen,
  ms: MatchedSet,
  byKey: Map<string, MatchedSet>,
  stat: 'atk' | 'spa',
  obs: DamageObservation[],
): void {
  const priorEvs = { ...ms.evs };
  const priorNature = ms.nature;
  const priorItem = ms.item ?? '';
  const { v: priorV, n: obsCount } = totalViolationOffense(gen, ms, byKey, priorEvs, priorNature, obs, priorItem);
  if (priorV <= KEEP_THRESHOLD) {
    ms.notes.push(`Observed ${stat.toUpperCase()} damage fits the dex spread (±${priorV.toFixed(1)}%).`);
    ms.confidence = Math.min(0.98, ms.confidence + 0.03);
    return;
  }
  const scale = evidenceScale(obsCount);
  // A mon needing MORE of this stat than the prior's 508-total budget allows
  // (a maxed spread that under-hits) can fund it from whatever it invests
  // LEAST in — same trade a scout would infer, generalized beyond Speed.
  const donors = donorOrder(priorEvs, [stat]);
  const floors: Partial<Record<keyof StatsTable, number>> = { spe: ms.speedFloor ?? 0 };
  const natures = [...new Set([priorNature, OFFENSE_NATURE[stat]])];
  // When the item wasn't revealed, let the search also try the damage items —
  // a Choice Specs / Life Orb explains "hits harder than any spread should".
  const items = ms.itemRevealed
    ? [priorItem]
    : dedupeItems([priorItem, '', ...offenseItemCandidates(ms, stat)]);
  // Regularized objective: violation + deviation-from-prior cost. EVs / nature /
  // item only move when the damage evidence justifies it (prevents overfitting
  // to HP% rounding) — but the more independent hits agree, the cheaper that
  // move gets (see evidenceScale).
  let best = { evs: priorEvs, nature: priorNature, item: priorItem, v: priorV, score: priorV };
  for (const item of items) {
    const itemCost = (sameItem(item, priorItem) ? 0 : ITEM_PENALTY) * scale;
    for (const nature of natures) {
      const natCost = (nature === priorNature ? 0 : NATURE_PENALTY) * scale;
      for (let ev = 0; ev <= EV_MAX; ev += EV_STEP) {
        const evs = allocateDonors(priorEvs, { [stat]: ev }, donors, floors);
        if (!evs) continue; // infeasible even after draining every donor
        const { v } = totalViolationOffense(gen, ms, byKey, evs, nature, obs, item);
        const devCost = LAMBDA * scale * totalDeviation(evs, priorEvs);
        const score = v + devCost + natCost + itemCost;
        if (score < best.score - 1e-6) best = { evs, nature, item, v, score };
      }
    }
  }
  const itemChanged = !sameItem(best.item, priorItem);
  const changed = totalDeviation(best.evs, priorEvs) > 1e-9 || best.nature !== priorNature || itemChanged;
  const improvement = priorV - best.v;
  // Adopt the best spread/item when it MATERIALLY beats the prior — even if the
  // residual isn't tiny. A defensive dex spread that badly under-predicts a KO
  // should yield to an offensive Choice-item read, not be kept just because the
  // fit is imperfect (defenders may still be mis-estimated this pass). Only when
  // nothing explains the damage better do we keep the prior and flag it.
  if (!changed || improvement < KEEP_THRESHOLD) {
    if (priorV > RESIDUAL_ACCEPT) {
      ms.notes.push(
        `Observed ${stat.toUpperCase()} damage doesn't cleanly fit any spread (residual ${priorV.toFixed(1)}%); keeping the dex spread — likely an unrevealed item/ability.`,
      );
      ms.confidence = Math.max(0.3, ms.confidence - 0.1);
    } else {
      ms.notes.push(`Observed ${stat.toUpperCase()} damage roughly fits the dex spread (±${priorV.toFixed(1)}%).`);
    }
    return;
  }
  const donorNote = donorNoteList(best.evs, priorEvs, donors);
  ms.evs = best.evs;
  ms.nature = best.nature;
  ms.evSource = 'derived';
  if (itemChanged) {
    ms.item = best.item || undefined;
    ms.notes.push(
      `Inferred ${best.item || 'no item'} from damage output (a plain spread couldn't reach the observed ${stat.toUpperCase()} damage).`,
    );
  }
  if (donorNote) ms.notes.push(`Traded ${donorNote} to afford ${stat.toUpperCase()} — the prior spread had no spare room.`);
  ms.notes.push(
    `Derived ${stat.toUpperCase()} = ${best.evs[stat] || 0} EVs${best.nature !== priorNature ? ` (${best.nature})` : ''} from observed damage (dex spread was off by ${priorV.toFixed(1)}%, residual ${best.v.toFixed(1)}%).`,
  );
  // Confidence tracks how well the adopted spread actually fits.
  ms.confidence = Math.max(
    0.3,
    Math.min(ms.confidence, best.v <= KEEP_THRESHOLD ? 0.8 : best.v <= RESIDUAL_ACCEPT ? 0.6 : 0.45),
  );
}

function totalViolationDefense(
  gen: CalcGen,
  ms: MatchedSet,
  byKey: Map<string, MatchedSet>,
  evs: Partial<StatsTable>,
  obs: DamageObservation[],
  nature?: string,
): ViolationResult {
  let v = 0;
  let n = 0;
  for (const o of obs) {
    const atk = byKey.get(key(o.attackerSide, o.attackerSpecies));
    if (!atk) continue;
    const attacker = buildPokemon(gen, atk, {
      boosts: o.field.attackerBoosts,
      status: o.field.attackerStatus,
      tera: o.field.attackerTera,
    });
    const defender = buildPokemon(gen, ms, {
      evs,
      nature,
      boosts: o.field.defenderBoosts,
      status: o.field.defenderStatus,
      tera: o.field.defenderTera,
    });
    if (!attacker || !defender) continue;
    const range = predictPct(gen, attacker, defender, o.move, buildField(gen, o.field));
    if (!range) continue;
    v += violation(o.observedPercent, range[0], range[1], o.koCapped);
    n++;
  }
  return { v: n ? v / n : 0, n }; // average per-observation
}

/** Like totalViolationDefense, but scored against the roll's midpoint
 *  (defenseFitDistance) — used only to SELECT the best-fitting EV value
 *  within the joint Def+SpD search; adoption/reporting still use the coarser
 *  totalViolationDefense so "did this actually clear the roll" stays the bar
 *  for whether a change is real. */
function totalFitDefense(
  gen: CalcGen,
  ms: MatchedSet,
  byKey: Map<string, MatchedSet>,
  evs: Partial<StatsTable>,
  obs: DamageObservation[],
  nature?: string,
): number {
  let d = 0;
  let n = 0;
  for (const o of obs) {
    const atk = byKey.get(key(o.attackerSide, o.attackerSpecies));
    if (!atk) continue;
    const attacker = buildPokemon(gen, atk, {
      boosts: o.field.attackerBoosts,
      status: o.field.attackerStatus,
      tera: o.field.attackerTera,
    });
    const defender = buildPokemon(gen, ms, {
      evs,
      nature,
      boosts: o.field.defenderBoosts,
      status: o.field.defenderStatus,
      tera: o.field.defenderTera,
    });
    if (!attacker || !defender) continue;
    const range = predictPct(gen, attacker, defender, o.move, buildField(gen, o.field));
    if (!range) continue;
    d += defenseFitDistance(o.observedPercent, range[0], range[1], o.koCapped);
    n++;
  }
  return n ? d / n : 0;
}

// Bulk natures to try per defensive stat — both polarities, since we can't
// always be sure whether the mon leans physical or special offensively.
const DEFENSE_NATURE_CANDIDATES: Record<'def' | 'spd', string[]> = {
  def: ['Bold', 'Impish'],
  spd: ['Calm', 'Careful'],
};

function refineDefense(
  gen: CalcGen,
  ms: MatchedSet,
  byKey: Map<string, MatchedSet>,
  stat: 'def' | 'spd',
  obs: DamageObservation[],
): void {
  const priorEvs = { ...ms.evs };
  const priorNature = ms.nature;
  const { v: priorV, n: obsCount } = totalViolationDefense(gen, ms, byKey, priorEvs, obs, priorNature);
  if (priorV <= KEEP_THRESHOLD) {
    ms.confidence = Math.min(0.98, ms.confidence + 0.03);
    return;
  }
  const scale = evidenceScale(obsCount);
  // hp/stat are fixed by the search below; anything else (commonly Speed, but
  // now genuinely any stat) can fund the difference when the prior's 508-total
  // budget leaves no spare room — the same trade a scout would infer ("hit for
  // less than a maxed build should, and nothing else grew, so something got
  // sacrificed for bulk"). Never below speedFloor: turn order already PROVED
  // that much Speed is real.
  const donors = donorOrder(priorEvs, ['hp', stat]);
  const floors: Partial<Record<keyof StatsTable, number>> = { spe: ms.speedFloor ?? 0 };
  const natures = [...new Set([priorNature, ...DEFENSE_NATURE_CANDIDATES[stat]])];
  let best = { evs: priorEvs, nature: priorNature, v: priorV, score: priorV };
  // Track the lowest-violation candidate seen too, separately from the min-
  // score one: @smogon/calc's damage rolls are discrete, so violation often
  // sits on a flat plateau (a range of EV values that all barely move it) and
  // only drops sharply once a candidate crosses the roll's rounding boundary.
  // A cheap point ON that plateau can out-score the point that actually
  // clears it, purely because the real fix costs a bit more deviation — which
  // would silently discard a candidate that genuinely explains the hit in
  // favor of one that doesn't explain it at all.
  let bestByFit = best;
  const searchHp = (hpCandidates: number[]) => {
    for (const nature of natures) {
      const natCost = (nature === priorNature ? 0 : NATURE_PENALTY) * scale;
      for (const hp of hpCandidates) {
        for (let ev = 0; ev <= EV_MAX; ev += EV_STEP) {
          const evs = allocateDonors(priorEvs, { hp, [stat]: ev }, donors, floors);
          if (!evs) continue; // infeasible even after draining every donor
          const { v } = totalViolationDefense(gen, ms, byKey, evs, obs, nature);
          const dev = totalDeviation(evs, priorEvs);
          const score = v + LAMBDA * scale * dev + natCost;
          if (score < best.score - 1e-6) best = { evs, nature, v, score };
          if (v < bestByFit.v - 1e-9) bestByFit = { evs, nature, v, score };
        }
      }
    }
  };
  // A single damage% observation constrains {hp, stat} to a whole curve, not a
  // point — one hit can never tell "extra HP" from "extra Def" apart, so
  // searching a fine HP grid on thin evidence just means the regularizer picks
  // an arbitrary point on that curve instead of admitting the ambiguity. Stay
  // on the old conservative 4-point shortlist ({prior, 0, 248, 252}) until
  // there's enough independent evidence (MIN_OBS_FOR_WIDE_HP+) to trust a
  // specific point — then widen coarse-then-fine so mid-range bulk (e.g. 208
  // HP) that shortlist could never reach becomes reachable. Full resolution
  // everywhere would be ~16x the search cost for no benefit outside the
  // eventual answer's neighborhood.
  const MIN_OBS_FOR_WIDE_HP = 3;
  if (obsCount >= MIN_OBS_FOR_WIDE_HP) {
    const HP_COARSE_STEP = 24;
    const coarseHp = new Set<number>([priorEvs.hp || 0, 0, EV_MAX]);
    for (let h = 0; h <= EV_MAX; h += HP_COARSE_STEP) coarseHp.add(h);
    searchHp([...coarseHp]);
    const center = best.evs.hp || 0;
    const fineHp = new Set<number>();
    for (let h = Math.max(0, center - HP_COARSE_STEP); h <= Math.min(EV_MAX, center + HP_COARSE_STEP); h += EV_STEP) {
      fineHp.add(h);
    }
    searchHp([...fineHp]);
  } else {
    searchHp([...new Set([priorEvs.hp || 0, 0, 248, 252])].filter((h) => h <= EV_MAX));
  }
  // If the min-score candidate doesn't clear the adoption bar on its own, but
  // a costlier candidate elsewhere in the search resolves the violation
  // enough to clear that bar by itself, prefer it — a real explanation for
  // the hit beats a cheap non-explanation that only wins on paper.
  if (priorV - best.v < KEEP_THRESHOLD && priorV - bestByFit.v >= KEEP_THRESHOLD) best = bestByFit;
  const changed = totalDeviation(best.evs, priorEvs) > 1e-9 || best.nature !== priorNature;
  const improvement = priorV - best.v;
  if (!changed || improvement < KEEP_THRESHOLD) {
    if (priorV > RESIDUAL_ACCEPT) {
      ms.notes.push(
        `Damage taken doesn't cleanly fit any HP/${stat.toUpperCase()} spread (residual ${priorV.toFixed(1)}%); keeping the dex spread.`,
      );
      ms.confidence = Math.max(0.3, ms.confidence - 0.1);
    }
    return;
  }
  const donorNote = donorNoteList(best.evs, priorEvs, donors);
  ms.evs = best.evs;
  if (best.nature !== priorNature) ms.nature = best.nature;
  if (donorNote) ms.notes.push(`Traded ${donorNote} for bulk — the maxed prior spread left no other room.`);
  ms.evSource = 'derived';
  ms.notes.push(
    `Derived HP/${stat.toUpperCase()} = ${best.evs.hp || 0}/${best.evs[stat] || 0}${best.nature !== priorNature ? ` (${best.nature})` : ''} EVs from damage taken (dex spread was off by ${priorV.toFixed(1)}%, residual ${best.v.toFixed(1)}%).`,
  );
  ms.confidence = Math.max(
    0.3,
    Math.min(ms.confidence, best.v <= KEEP_THRESHOLD ? 0.7 : best.v <= RESIDUAL_ACCEPT ? 0.55 : 0.45),
  );
}

/**
 * When a mon has evidence for BOTH Def and SpD, refine them TOGETHER instead
 * of as two independent passes. Running them separately lets whichever runs
 * second silently re-pick HP with no memory of what the first pass's fit
 * depended on — a mon that's genuinely a mixed wall (moderate Def AND SpD,
 * high HP) can end up maxed on one defense stat with the other at zero,
 * because each category only ever asked "what's the best HP/stat pair for
 * MY evidence alone", never "what HP works for both". This searches Def and
 * SpD's best value at each candidate HP jointly, so a mon whose evidence
 * points to real investment in both actually ends up with real investment
 * in both, instead of one figure overwriting the other's compromise.
 */
function refineDefensePair(
  gen: CalcGen,
  ms: MatchedSet,
  byKey: Map<string, MatchedSet>,
  defObs: DamageObservation[],
  spdObs: DamageObservation[],
): void {
  if (defObs.length > 0 && spdObs.length === 0) return refineDefense(gen, ms, byKey, 'def', defObs);
  if (spdObs.length > 0 && defObs.length === 0) return refineDefense(gen, ms, byKey, 'spd', spdObs);
  if (defObs.length === 0 && spdObs.length === 0) return;

  const priorEvs = { ...ms.evs };
  const priorNature = ms.nature;
  // Gate on the coarse "does this fall inside the roll range at all" check —
  // if the current spread isn't actually CONTRADICTED by either category,
  // there's nothing to fix (matches "if a shared dex set already covers
  // every calc, just use it").
  const { v: priorDefV, n: defN } = totalViolationDefense(gen, ms, byKey, priorEvs, defObs, priorNature);
  const { v: priorSpdV, n: spdN } = totalViolationDefense(gen, ms, byKey, priorEvs, spdObs, priorNature);
  if (priorDefV <= KEEP_THRESHOLD && priorSpdV <= KEEP_THRESHOLD) {
    ms.confidence = Math.min(0.98, ms.confidence + 0.03);
    return;
  }

  const defScale = evidenceScale(defN);
  const spdScale = evidenceScale(spdN);
  const jointScale = Math.max(defScale, spdScale);
  // Both Def and SpD are fixed together for the joint search — donors can't
  // include either, same principle as the single-stat search excluding hp+stat.
  const donors = donorOrder(priorEvs, ['hp', 'def', 'spd']);
  const floors: Partial<Record<keyof StatsTable, number>> = { spe: ms.speedFloor ?? 0 };
  const natures = [...new Set([priorNature, ...DEFENSE_NATURE_CANDIDATES.def, ...DEFENSE_NATURE_CANDIDATES.spd])];
  const priorDefFit = totalFitDefense(gen, ms, byKey, priorEvs, defObs, priorNature);
  const priorSpdFit = totalFitDefense(gen, ms, byKey, priorEvs, spdObs, priorNature);

  // Best Def (or SpD) value AT a fixed hp. Selection uses the AVERAGE-ROLL
  // distance (defenseFitDistance/totalFitDefense) rather than the coarse
  // in-range check — "any value that doesn't contradict the roll" leaves a
  // wide plateau of equally-"valid" EV values with no way to prefer the
  // statistically likely one; scoring against the roll's midpoint gives the
  // search an actual gradient toward the best-supported number, mirroring
  // "solve for the EV where this hit is an average roll".
  const bestAt = (hp: number, statKey: 'def' | 'spd', catObs: DamageObservation[], nature: string, priorFit: number, scale: number) => {
    const priorStat = priorEvs[statKey] || 0;
    // If the PRIOR stat value doesn't actually violate at this hp, leave it
    // alone — don't go hunting for a "more centered" replacement when
    // there's no contradiction to resolve. Otherwise a category that
    // already fit fine could still drift toward a marginally-more-robust
    // number purely because HP moved to satisfy the OTHER category.
    const priorEvsHere = allocateDonors(priorEvs, { hp, [statKey]: priorStat }, donors, floors);
    if (priorEvsHere) {
      const { v: priorVHere } = totalViolationDefense(gen, ms, byKey, priorEvsHere, catObs, nature);
      if (priorVHere <= KEEP_THRESHOLD) return { ev: priorStat, v: priorVHere };
    }
    let best = { ev: priorStat, fit: priorFit, score: priorFit };
    for (let ev = 0; ev <= EV_MAX; ev += EV_STEP) {
      const evs = allocateDonors(priorEvs, { hp, [statKey]: ev }, donors, floors);
      if (!evs) continue;
      const fit = totalFitDefense(gen, ms, byKey, evs, catObs, nature);
      const dev = Math.abs(ev - priorStat) / EV_MAX;
      const score = fit + LAMBDA * scale * dev;
      if (score < best.score - 1e-6) best = { ev, fit, score };
    }
    // Report the coarse in-range violation for the WINNING ev — adoption,
    // confidence, and note text stay grounded in "does this clear the roll",
    // not the finer average-roll distance used only to pick the ev itself.
    const winEvs = allocateDonors(priorEvs, { hp, [statKey]: best.ev }, donors, floors)!;
    const { v } = totalViolationDefense(gen, ms, byKey, winEvs, catObs, nature);
    return { ev: best.ev, v };
  };

  const priorCombinedV = priorDefV * defScale + priorSpdV * spdScale;
  let best = {
    evs: priorEvs, nature: priorNature,
    defV: priorDefV, spdV: priorSpdV, combinedV: priorCombinedV,
    score: priorCombinedV,
  };

  const minObs = Math.min(defN, spdN);
  const hpCandidateSet = new Set<number>([priorEvs.hp || 0, 0, 248, 252].filter((h) => h <= EV_MAX));
  if (minObs >= 3) for (let h = 0; h <= EV_MAX; h += 24) hpCandidateSet.add(h);
  const hpCandidates = [...hpCandidateSet];

  for (const nature of natures) {
    const natCost = (nature === priorNature ? 0 : NATURE_PENALTY) * jointScale;
    for (const hp of hpCandidates) {
      const bestDef = bestAt(hp, 'def', defObs, nature, priorDefFit, defScale);
      const bestSpd = bestAt(hp, 'spd', spdObs, nature, priorSpdFit, spdScale);
      const evs = allocateDonors(priorEvs, { hp, def: bestDef.ev, spd: bestSpd.ev }, donors, floors);
      if (!evs) continue;
      const combinedV = bestDef.v * defScale + bestSpd.v * spdScale;
      // HP costs less than Def/SpD to move away from prior — a mixed wall's
      // most efficient lever is HP (it helps against both attack types at
      // once), so when multiple hp/def/spd combinations fit similarly well,
      // this biases the search toward the one that leans on HP first and
      // only reaches for Def/SpD to cover what HP alone couldn't.
      const dev = weightedDeviation(evs, priorEvs);
      const score = combinedV + LAMBDA * jointScale * dev + natCost;
      if (score < best.score - 1e-6) best = { evs, nature, defV: bestDef.v, spdV: bestSpd.v, combinedV, score };
    }
  }

  const changed = totalDeviation(best.evs, priorEvs) > 1e-9 || best.nature !== priorNature;
  const improvement = priorCombinedV - best.combinedV;
  if (!changed || improvement < KEEP_THRESHOLD) {
    if (priorDefV > RESIDUAL_ACCEPT || priorSpdV > RESIDUAL_ACCEPT) {
      ms.notes.push(
        `Damage taken doesn't cleanly fit any HP/Def/SpD split (residual ${priorDefV.toFixed(1)}% Def, ${priorSpdV.toFixed(1)}% SpD); keeping the dex spread.`,
      );
      ms.confidence = Math.max(0.3, ms.confidence - 0.1);
    }
    return;
  }
  const donorNote = donorNoteList(best.evs, priorEvs, donors);
  ms.evs = best.evs;
  if (best.nature !== priorNature) ms.nature = best.nature;
  if (donorNote) ms.notes.push(`Traded ${donorNote} for bulk — the maxed prior spread left no other room.`);
  ms.evSource = 'derived';
  ms.notes.push(
    `Derived HP/Def/SpD = ${best.evs.hp || 0}/${best.evs.def || 0}/${best.evs.spd || 0}${best.nature !== priorNature ? ` (${best.nature})` : ''} EVs jointly from damage taken (residual ${best.defV.toFixed(1)}% Def, ${best.spdV.toFixed(1)}% SpD).`,
  );
  ms.confidence = Math.max(
    0.3,
    Math.min(ms.confidence, best.combinedV <= KEEP_THRESHOLD ? 0.7 : best.combinedV <= RESIDUAL_ACCEPT ? 0.55 : 0.45),
  );
}

// ---------------------------------------------------------------------------
// Speed derivation: the ONLY direct evidence a replay gives about a mon's
// actual Speed is turn order. Unlike damage (which has HP%-rounding and RNG-
// roll noise, so single deviations are treated cautiously), a same-priority
// turn-order fact is deterministic — one clean contradiction is proof the
// current spread is wrong, not something to average away.
// ---------------------------------------------------------------------------

// Stage multiplier for stat stages -6..+6, indexed by stage+6.
const STAGE_MULT = [2 / 8, 2 / 7, 2 / 6, 2 / 5, 2 / 4, 2 / 3, 1, 1.5, 2, 2.5, 3, 3.5, 4];

/** Effective (boosted, status-adjusted, item-adjusted) Speed for a comparison. */
function effectiveSpeed(
  gen: CalcGen,
  ms: MatchedSet,
  evs: Partial<StatsTable>,
  nature: string,
  item: string,
  boostStage: number,
  status: string | undefined,
): number | null {
  const p = buildPokemon(gen, ms, { evs, nature, item });
  if (!p) return null;
  const stage = Math.max(-6, Math.min(6, Math.round(boostStage)));
  let spe = p.rawStats.spe * STAGE_MULT[stage + 6]!;
  if (status === 'par') spe *= gen.num >= 7 ? 0.5 : 0.25;
  if (toID(item).startsWith('choicescarf')) spe *= 1.5;
  return Math.floor(spe);
}

/** How many of `obs` contradict this (spe, nature, item) for `ms`? */
function speedViolations(
  gen: CalcGen,
  ms: MatchedSet,
  byKey: Map<string, MatchedSet>,
  selfKey: string,
  obs: SpeedObservation[],
  spe: number,
  nature: string,
  item: string,
): { violations: number; checked: number } {
  let violations = 0;
  let checked = 0;
  for (const o of obs) {
    const selfIsFaster = key(o.fasterSide, o.fasterSpecies) === selfKey;
    const oppKey = selfIsFaster ? key(o.slowerSide, o.slowerSpecies) : key(o.fasterSide, o.fasterSpecies);
    const opp = byKey.get(oppKey);
    if (!opp) continue;
    const selfBoost = (selfIsFaster ? o.fasterBoosts.spe : o.slowerBoosts.spe) || 0;
    const selfStatus = selfIsFaster ? o.fasterStatus : o.slowerStatus;
    const oppBoost = (selfIsFaster ? o.slowerBoosts.spe : o.fasterBoosts.spe) || 0;
    const oppStatus = selfIsFaster ? o.slowerStatus : o.fasterStatus;

    const selfSpeed = effectiveSpeed(gen, ms, { ...ms.evs, spe }, nature, item, selfBoost, selfStatus);
    const oppSpeed = effectiveSpeed(gen, opp, opp.evs, opp.nature, opp.item ?? '', oppBoost, oppStatus);
    if (selfSpeed === null || oppSpeed === null) continue;
    checked++;
    if (selfIsFaster ? selfSpeed <= oppSpeed : selfSpeed >= oppSpeed) violations++;
  }
  return { violations, checked };
}

const SPEED_NATURE_CANDIDATES = ['Timid', 'Jolly'];

function refineSpeed(gen: CalcGen, ms: MatchedSet, byKey: Map<string, MatchedSet>, selfKey: string, obs: SpeedObservation[]): void {
  const priorSpe = ms.evs.spe || 0;
  const priorNature = ms.nature;
  const priorItem = ms.item ?? '';

  const { violations: priorViol, checked } = speedViolations(gen, ms, byKey, selfKey, obs, priorSpe, priorNature, priorItem);
  if (checked === 0) return; // no opponent data to verify against yet
  if (priorViol === 0) {
    ms.notes.push(`Speed confirmed by turn order (${checked} observation${checked > 1 ? 's' : ''}).`);
    ms.confidence = Math.min(0.98, ms.confidence + 0.05);
    // Still record the floor: the lowest Speed EVs consistent with the evidence,
    // for the bulk-trade below to respect even when nothing needed correcting.
    for (let spe = 0; spe <= priorSpe; spe += EV_STEP) {
      if (speedViolations(gen, ms, byKey, selfKey, obs, spe, priorNature, priorItem).violations === 0) {
        ms.speedFloor = spe;
        break;
      }
    }
    return;
  }

  const natures = [...new Set([priorNature, ...SPEED_NATURE_CANDIDATES])];
  const items = ms.itemRevealed ? [priorItem] : dedupeItems([priorItem, '', 'Choice Scarf']);
  const priorEvs = { ...ms.evs };
  // Any other stat can fund the Speed increase when the prior's 508-total
  // budget leaves no spare room — turn order proved the Speed is real, so the
  // search must be able to reach it even from an already-maxed prior.
  const donors = donorOrder(priorEvs, ['spe']);
  // Violations dominate the score (a contradiction is never acceptable); EV
  // deviation and nature/item cost only break ties among equally-valid fits.
  let best: { evs: Partial<StatsTable>; nature: string; item: string; viol: number; score: number } = {
    evs: priorEvs,
    nature: priorNature,
    item: priorItem,
    viol: priorViol,
    score: priorViol * 1000,
  };
  for (const item of items) {
    const itemCost = sameItem(item, priorItem) ? 0 : ITEM_PENALTY;
    for (const nature of natures) {
      const natCost = nature === priorNature ? 0 : NATURE_PENALTY;
      for (let spe = 0; spe <= EV_MAX; spe += EV_STEP) {
        const evs = allocateDonors(priorEvs, { spe }, donors, {});
        if (!evs) continue; // infeasible even after draining every donor
        const { violations } = speedViolations(gen, ms, byKey, selfKey, obs, spe, nature, item);
        const dev = LAMBDA * totalDeviation(evs, priorEvs);
        const score = violations * 1000 + dev + natCost + itemCost;
        if (score < best.score - 1e-6) best = { evs, nature, item, viol: violations, score };
      }
    }
  }

  if (best.viol > 0) {
    ms.notes.push(
      `Speed doesn't fit any spread cleanly (${best.viol}/${checked} turn-order observation(s) unexplained) — keeping the dex spread; ` +
        'possibly an unmodeled speed modifier (weather-boosted ability, Tailwind) or an inaccurate opponent Speed read.',
    );
    ms.confidence = Math.max(0.3, ms.confidence - 0.1);
    return;
  }

  const itemChanged = !sameItem(best.item, priorItem);
  const donorNote = donorNoteList(best.evs, priorEvs, donors);
  ms.evs = best.evs;
  if (best.nature !== priorNature) ms.nature = best.nature;
  if (itemChanged) {
    ms.item = best.item || undefined;
    ms.itemRevealed = false; // still an inference, not a reveal
    ms.notes.push(`Inferred ${best.item || 'no item'} — no plain Speed spread explains the observed turn order.`);
  }
  if (donorNote) ms.notes.push(`Traded ${donorNote} for Speed — the prior spread had no room, but turn order proved it.`);
  ms.evSource = 'derived';
  ms.notes.push(
    `Derived Speed = ${best.evs.spe || 0} EVs${best.nature !== priorNature ? ` (${best.nature})` : ''} from turn order (${checked} observation(s)).`,
  );
  ms.confidence = Math.max(0.3, Math.min(ms.confidence, 0.85));
  // Record the floor at this (now-corrected) nature/item for the bulk trade below.
  for (let spe = 0; spe <= (best.evs.spe || 0); spe += EV_STEP) {
    if (speedViolations(gen, ms, byKey, selfKey, obs, spe, best.nature, best.item).violations === 0) {
      ms.speedFloor = spe;
      break;
    }
  }
}

/** Derive each mon's Speed from observed turn order. Run before deriveEvs so
 *  its speedFloor is available when the defense pass considers a bulk trade. */
export function deriveSpeed(genNum: number, teams: SideSets[], observations: SpeedObservation[]): void {
  if (genNum <= 2) return; // no calculable EVs for RBY/GSC
  const gen = calc.Generations.get(genNum as GenerationNum);
  const byKey = new Map<string, MatchedSet>();
  for (const t of teams) for (const s of t.sets) byKey.set(key(t.side, s.baseSpecies), s);

  for (const t of teams) {
    for (const ms of t.sets) {
      if (ms.unrevealed) continue;
      const selfKey = key(t.side, ms.baseSpecies);
      const relevant = observations.filter(
        (o) => key(o.fasterSide, o.fasterSpecies) === selfKey || key(o.slowerSide, o.slowerSpecies) === selfKey,
      );
      if (relevant.length === 0) continue;
      refineSpeed(gen, ms, byKey, selfKey, relevant);
    }
  }
}

// ---------------------------------------------------------------------------
// Damage-based set SELECTION: when reveals don't disambiguate a mon's candidate
// dex/historical sets, let the observed damage pick the best-fitting one. This
// is what tells a defensive Tapu Bulu from an offensive one when only a shared
// move (Horn Leech) was revealed.
// ---------------------------------------------------------------------------

export interface SideCandidates {
  side: 'p1' | 'p2';
  /** Per-mon ranked candidate sets (index 0 = reveal-best). Length >= 1. */
  candidates: MatchedSet[][];
}

// Require this much average-residual improvement to abandon the reveal-best set.
// Lower = damage evidence overrides the usage/reveal prior set more readily.
const SELECT_MARGIN = 1.5;

function residualForMon(
  gen: CalcGen,
  ms: MatchedSet,
  chosen: Map<string, MatchedSet>,
  selfKey: string,
  obs: DamageObservation[],
): number {
  let v = 0;
  let n = 0;
  for (const o of obs) {
    const aKey = key(o.attackerSide, o.attackerSpecies);
    const dKey = key(o.defenderSide, o.defenderSpecies);
    let attackerSet: MatchedSet | undefined;
    let defenderSet: MatchedSet | undefined;
    if (aKey === selfKey) {
      attackerSet = ms;
      defenderSet = chosen.get(dKey);
    } else if (dKey === selfKey) {
      attackerSet = chosen.get(aKey);
      defenderSet = ms;
    } else continue;
    if (!attackerSet || !defenderSet) continue;
    const attacker = buildPokemon(gen, attackerSet, {
      boosts: o.field.attackerBoosts,
      status: o.field.attackerStatus,
      tera: o.field.attackerTera,
    });
    const defender = buildPokemon(gen, defenderSet, {
      boosts: o.field.defenderBoosts,
      status: o.field.defenderStatus,
      tera: o.field.defenderTera,
    });
    if (!attacker || !defender) continue;
    const range = predictPct(gen, attacker, defender, o.move, buildField(gen, o.field));
    if (!range) continue;
    v += violation(o.observedPercent, range[0], range[1], o.koCapped);
    n++;
  }
  return n ? v / n : 0;
}

/**
 * Choose, for each mon, the candidate set whose stock spread best explains the
 * damage in this replay. Coordinate descent (a couple of rounds) because a
 * mon's fit depends on the currently-chosen sets of the mons it interacted with.
 * Returns the chosen set per mon (unmodified EVs — deriveEvs fine-tunes after).
 */
export function selectSetsByDamage(
  genNum: number,
  teams: SideCandidates[],
  observations: DamageObservation[],
): SideSets[] {
  // Gens 1–2: no damage-based set selection — use the reveal-best candidate as-is.
  if (genNum <= 2) {
    return teams.map((t) => ({ side: t.side, sets: t.candidates.map((list) => list[0]!) }));
  }
  const gen = calc.Generations.get(genNum as GenerationNum);
  const usable = observations.filter((o) => o.usable);
  const candByKey = new Map<string, MatchedSet[]>();
  const chosen = new Map<string, MatchedSet>();
  for (const t of teams) {
    for (const list of t.candidates) {
      const k = key(t.side, list[0]!.baseSpecies);
      candByKey.set(k, list);
      chosen.set(k, list[0]!);
    }
  }

  for (let round = 0; round < 2; round++) {
    for (const [k, list] of candByKey) {
      if (list.length < 2) continue;
      const monObs = usable.filter(
        (o) => key(o.attackerSide, o.attackerSpecies) === k || key(o.defenderSide, o.defenderSpecies) === k,
      );
      if (monObs.length === 0) continue;
      const revealBest = list[0]!;
      const revealBestR = residualForMon(gen, revealBest, chosen, k, monObs);
      let best = { set: revealBest, r: revealBestR };
      for (let i = 1; i < list.length; i++) {
        const r = residualForMon(gen, list[i]!, chosen, k, monObs);
        if (r < best.r - 1e-6) best = { set: list[i]!, r };
      }
      // Only switch away from the reveal-best if materially better.
      const winner = best.set !== revealBest && best.r < revealBestR - SELECT_MARGIN ? best.set : revealBest;
      if (winner !== chosen.get(k)) {
        if (winner !== revealBest) {
          winner.notes.push(
            `Set chosen by damage evidence (residual ${best.r.toFixed(1)}% vs ${revealBestR.toFixed(1)}% for the reveal-best "${revealBest.matchedRole}").`,
          );
        }
        chosen.set(k, winner);
      }
    }
  }

  return teams.map((t) => ({
    side: t.side,
    sets: t.candidates.map((list) => chosen.get(key(t.side, list[0]!.baseSpecies))!),
  }));
}
