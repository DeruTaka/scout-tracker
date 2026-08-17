// Derive plausible EV spreads by reconciling each matched set against the
// actual damage seen in the replay, using @smogon/calc as the oracle. Starts
// from the dex-set spread (the prior) and, only where observed damage falls
// outside the prior's predicted range, searches for the minimal-deviation
// legal spread that fits.
import * as calc from '@smogon/calc';
import type { GenerationNum } from '@pkmn/data';
type CalcGen = ReturnType<typeof calc.Generations.get>;
import type { DamageObservation, FieldSnapshot, MatchedSet, SpeedObservation, StatsTable } from '../types.js';
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
    const p = new calc.Pokemon(gen, ms.baseSpecies, {
      level: ms.level,
      item: (opts.item !== undefined ? opts.item : ms.item) || undefined,
      ability: ms.ability,
      nature: opts.nature ?? ms.nature,
      evs: opts.evs ?? ms.evs,
      ivs: ms.ivs,
      boosts: opts.boosts,
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

function evSumExcluding(evs: Partial<StatsTable>, exclude: (keyof StatsTable)[]): number {
  let total = 0;
  for (const k of ['hp', 'atk', 'def', 'spa', 'spd', 'spe'] as const) {
    if (!exclude.includes(k)) total += evs[k] || 0;
  }
  return total;
}

/**
 * Refine `sets` in place. `teams` supplies the side of each set so that the
 * same species on both teams is handled correctly.
 */
export function deriveEvs(genNum: number, teams: SideSets[], observations: DamageObservation[]): void {
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
  for (const [k, obs] of defenseByDefender) {
    const ms = byKey.get(k);
    if (!ms) continue;
    for (const stat of ['def', 'spd'] as const) {
      const catObs = obs.filter((o) => {
        const c = gen.moves.get(toID(o.move) as any)?.category;
        return (stat === 'def' && c === 'Physical') || (stat === 'spd' && c === 'Special');
      });
      if (catObs.length === 0) continue;
      refineDefense(gen, ms, byKey, stat, catObs);
    }
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
  const priorEv = ms.evs[stat] || 0;
  const priorNature = ms.nature;
  const priorItem = ms.item ?? '';
  const { v: priorV, n: obsCount } = totalViolationOffense(gen, ms, byKey, ms.evs, priorNature, obs, priorItem);
  if (priorV <= KEEP_THRESHOLD) {
    ms.notes.push(`Observed ${stat.toUpperCase()} damage fits the dex spread (±${priorV.toFixed(1)}%).`);
    ms.confidence = Math.min(0.98, ms.confidence + 0.03);
    return;
  }
  const scale = evidenceScale(obsCount);
  const otherSum = evSumExcluding(ms.evs, [stat]);
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
  let best = { ev: priorEv, nature: priorNature, item: priorItem, v: priorV, score: priorV };
  for (const item of items) {
    const itemCost = (sameItem(item, priorItem) ? 0 : ITEM_PENALTY) * scale;
    for (const nature of natures) {
      for (let ev = 0; ev <= EV_MAX; ev += EV_STEP) {
        if (otherSum + ev > EV_TOTAL) break;
        const { v } = totalViolationOffense(gen, ms, byKey, { ...ms.evs, [stat]: ev }, nature, obs, item);
        const devCost = LAMBDA * scale * (Math.abs(ev - priorEv) / EV_MAX);
        const natCost = (nature === priorNature ? 0 : NATURE_PENALTY) * scale;
        const score = v + devCost + natCost + itemCost;
        if (score < best.score - 1e-6) best = { ev, nature, item, v, score };
      }
    }
  }
  const itemChanged = !sameItem(best.item, priorItem);
  const changed = best.ev !== priorEv || best.nature !== priorNature || itemChanged;
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
  ms.evs = { ...ms.evs, [stat]: best.ev };
  ms.nature = best.nature;
  ms.evSource = 'derived';
  if (itemChanged) {
    ms.item = best.item || undefined;
    ms.notes.push(
      `Inferred ${best.item || 'no item'} from damage output (a plain spread couldn't reach the observed ${stat.toUpperCase()} damage).`,
    );
  }
  ms.notes.push(
    `Derived ${stat.toUpperCase()} = ${best.ev} EVs${best.nature !== priorNature ? ` (${best.nature})` : ''} from observed damage (dex spread was off by ${priorV.toFixed(1)}%, residual ${best.v.toFixed(1)}%).`,
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
  const priorHp = ms.evs.hp || 0;
  const priorDef = ms.evs[stat] || 0;
  const priorSpe = ms.evs.spe || 0;
  const priorNature = ms.nature;
  const { v: priorV, n: obsCount } = totalViolationDefense(gen, ms, byKey, ms.evs, obs, priorNature);
  if (priorV <= KEEP_THRESHOLD) {
    ms.confidence = Math.min(0.98, ms.confidence + 0.03);
    return;
  }
  const scale = evidenceScale(obsCount);
  // Speed is excluded from the fixed baseline: a dex/usage prior often already
  // spends the full 508 EVs on offense (e.g. 252/4/252), which would otherwise
  // make added bulk mathematically impossible to reach regardless of evidence.
  // Let the search sacrifice Speed to make room — the same trade a human scout
  // would infer ("hit for less than a maxed build should, and nothing else
  // grew, so something got sacrificed for bulk") — at its own regularized cost.
  // Never below speedFloor: turn order already PROVED that much Speed is real.
  const speedFloor = ms.speedFloor ?? 0;
  const otherSum = evSumExcluding(ms.evs, ['hp', stat, 'spe']);
  const hpCandidates = [...new Set([priorHp, 0, 248, 252])].filter((h) => h <= EV_MAX);
  const natures = [...new Set([priorNature, ...DEFENSE_NATURE_CANDIDATES[stat]])];
  let best = { hp: priorHp, ev: priorDef, spe: priorSpe, nature: priorNature, v: priorV, score: priorV };
  for (const nature of natures) {
    const natCost = (nature === priorNature ? 0 : NATURE_PENALTY) * scale;
    for (const hp of hpCandidates) {
      for (let ev = 0; ev <= EV_MAX; ev += EV_STEP) {
        if (otherSum + hp + ev > EV_TOTAL) break; // infeasible even sacrificing all Speed
        const speBudget = EV_TOTAL - otherSum - hp - ev;
        const spe = Math.max(speedFloor, Math.min(priorSpe, speBudget));
        if (spe < speedFloor) continue; // can't fit without violating proven Speed
        const { v } = totalViolationDefense(gen, ms, byKey, { ...ms.evs, hp, [stat]: ev, spe }, obs, nature);
        const dev = (Math.abs(hp - priorHp) + Math.abs(ev - priorDef) + Math.abs(spe - priorSpe)) / EV_MAX;
        const score = v + LAMBDA * scale * dev + natCost;
        if (score < best.score - 1e-6) best = { hp, ev, spe, nature, v, score };
      }
    }
  }
  const changed = best.hp !== priorHp || best.ev !== priorDef || best.spe !== priorSpe || best.nature !== priorNature;
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
  ms.evs = { ...ms.evs, hp: best.hp, [stat]: best.ev, spe: best.spe };
  if (best.nature !== priorNature) ms.nature = best.nature;
  if (best.spe !== priorSpe) {
    ms.notes.push(`Traded ${priorSpe - best.spe} Speed EVs for bulk — the maxed offensive prior left no other room.`);
  }
  ms.evSource = 'derived';
  ms.notes.push(
    `Derived HP/${stat.toUpperCase()} = ${best.hp}/${best.ev}${best.nature !== priorNature ? ` (${best.nature})` : ''} EVs from damage taken (dex spread was off by ${priorV.toFixed(1)}%, residual ${best.v.toFixed(1)}%).`,
  );
  ms.confidence = Math.max(
    0.3,
    Math.min(ms.confidence, best.v <= KEEP_THRESHOLD ? 0.7 : best.v <= RESIDUAL_ACCEPT ? 0.55 : 0.45),
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
  const otherSum = evSumExcluding(ms.evs, ['spe']);
  // Violations dominate the score (a contradiction is never acceptable); EV
  // deviation and nature/item cost only break ties among equally-valid fits.
  let best = { spe: priorSpe, nature: priorNature, item: priorItem, viol: priorViol, score: priorViol * 1000 };
  for (const item of items) {
    const itemCost = sameItem(item, priorItem) ? 0 : ITEM_PENALTY;
    for (const nature of natures) {
      const natCost = nature === priorNature ? 0 : NATURE_PENALTY;
      for (let spe = 0; spe <= EV_MAX; spe += EV_STEP) {
        if (otherSum + spe > EV_TOTAL) break;
        const { violations } = speedViolations(gen, ms, byKey, selfKey, obs, spe, nature, item);
        const dev = LAMBDA * (Math.abs(spe - priorSpe) / EV_MAX);
        const score = violations * 1000 + dev + natCost + itemCost;
        if (score < best.score - 1e-6) best = { spe, nature, item, viol: violations, score };
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
  ms.evs = { ...ms.evs, spe: best.spe };
  if (best.nature !== priorNature) ms.nature = best.nature;
  if (itemChanged) {
    ms.item = best.item || undefined;
    ms.itemRevealed = false; // still an inference, not a reveal
    ms.notes.push(`Inferred ${best.item || 'no item'} — no plain Speed spread explains the observed turn order.`);
  }
  ms.evSource = 'derived';
  ms.notes.push(
    `Derived Speed = ${best.spe} EVs${best.nature !== priorNature ? ` (${best.nature})` : ''} from turn order (${checked} observation(s)).`,
  );
  ms.confidence = Math.max(0.3, Math.min(ms.confidence, 0.85));
  // Record the floor at this (now-corrected) nature/item for the bulk trade below.
  for (let spe = 0; spe <= best.spe; spe += EV_STEP) {
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
