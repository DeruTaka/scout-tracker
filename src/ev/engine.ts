// Derive plausible EV spreads by reconciling each matched set against the
// actual damage seen in the replay, using @smogon/calc as the oracle. Starts
// from the dex-set spread (the prior) and, only where observed damage falls
// outside the prior's predicted range, searches for the minimal-deviation
// legal spread that fits.
import * as calc from '@smogon/calc';
import type { GenerationNum } from '@pkmn/data';
type CalcGen = ReturnType<typeof calc.Generations.get>;
import type { DamageObservation, FieldSnapshot, MatchedSet, StatsTable } from '../types.js';
import { toID } from '../data/dex.js';

const TOL = 1.5; // percent-point tolerance for HP% rounding
const EV_STEP = 4;
const EV_MAX = 252;
const EV_TOTAL = 508;
// Keep the dex prior unless the summed violation exceeds this (percent points).
const KEEP_THRESHOLD = 2.0;
// Regularization: cost (in violation-equivalent points) of moving the full 252
// EVs away from the prior. Stops the search overfitting to rounding noise.
const LAMBDA = 5;
// Extra cost for flipping the dex-set's nature; only done under strong evidence.
const NATURE_PENALTY = 6;
// If even the best-fit spread can't get within this residual, the evidence
// doesn't cleanly fit any spread (likely an unrevealed item/ability) — keep the
// dex prior rather than emit a bogus spread.
const RESIDUAL_ACCEPT = 5;

export interface SideSets {
  side: 'p1' | 'p2';
  sets: MatchedSet[];
}

const OFFENSE_NATURE: Record<'atk' | 'spa', string> = { atk: 'Adamant', spa: 'Modest' };

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
  },
): calc.Pokemon | null {
  // Some species/formes aren't resolvable in calc's dataset for a given gen
  // (e.g. Aegislash's base forme in gen 8). Those simply skip EV derivation.
  try {
    const p = new calc.Pokemon(gen, ms.baseSpecies, {
      level: ms.level,
      item: ms.item,
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

function violation(observed: number, lo: number, hi: number, koCapped: boolean): number {
  // For a KO the observed % is only a LOWER bound on true damage, so we only
  // penalize UNDER-prediction (predicted max can't even reach what we saw).
  if (koCapped) return observed > hi + TOL ? observed - (hi + TOL) : 0;
  if (observed < lo - TOL) return lo - TOL - observed;
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

function totalViolationOffense(
  gen: CalcGen,
  ms: MatchedSet,
  byKey: Map<string, MatchedSet>,
  evs: Partial<StatsTable>,
  nature: string,
  obs: DamageObservation[],
): number {
  let v = 0;
  let n = 0;
  for (const o of obs) {
    const def = byKey.get(key(o.defenderSide, o.defenderSpecies));
    if (!def) continue;
    const attacker = buildPokemon(gen, ms, {
      evs,
      nature,
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
    v += violation(o.observedPercent, range[0], range[1], o.koCapped);
    n++;
  }
  return n ? v / n : 0; // average per-observation, so noisy hits don't compound
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
  const priorV = totalViolationOffense(gen, ms, byKey, ms.evs, priorNature, obs);
  if (priorV <= KEEP_THRESHOLD) {
    ms.notes.push(`Observed ${stat.toUpperCase()} damage fits the dex spread (±${priorV.toFixed(1)}%).`);
    ms.confidence = Math.min(0.98, ms.confidence + 0.03);
    return;
  }
  const otherSum = evSumExcluding(ms.evs, [stat]);
  const natures = [...new Set([priorNature, OFFENSE_NATURE[stat]])];
  // Regularized objective: violation + deviation-from-prior cost. EVs only move
  // when the damage evidence justifies it (prevents overfitting to HP% rounding).
  let best = { ev: priorEv, nature: priorNature, v: priorV, score: priorV };
  for (const nature of natures) {
    for (let ev = 0; ev <= EV_MAX; ev += EV_STEP) {
      if (otherSum + ev > EV_TOTAL) break;
      const v = totalViolationOffense(gen, ms, byKey, { ...ms.evs, [stat]: ev }, nature, obs);
      const devCost = LAMBDA * (Math.abs(ev - priorEv) / EV_MAX);
      const natCost = nature === priorNature ? 0 : NATURE_PENALTY;
      const score = v + devCost + natCost;
      if (score < best.score - 1e-6) best = { ev, nature, v, score };
    }
  }
  if (best.v > RESIDUAL_ACCEPT) {
    ms.notes.push(
      `Observed ${stat.toUpperCase()} damage doesn't cleanly fit any spread (best residual ${best.v.toFixed(1)}%); keeping the dex spread — likely an unrevealed item/ability.`,
    );
    ms.confidence = Math.max(0.3, ms.confidence - 0.1);
  } else if (best.ev !== priorEv || best.nature !== priorNature) {
    ms.evs = { ...ms.evs, [stat]: best.ev };
    ms.nature = best.nature;
    ms.evSource = 'derived';
    ms.notes.push(
      `Derived ${stat.toUpperCase()} = ${best.ev} EVs${best.nature !== priorNature ? ` (${best.nature})` : ''} from observed damage (dex spread was off by ${priorV.toFixed(1)}%, residual ${best.v.toFixed(1)}%).`,
    );
    ms.confidence = Math.max(0.3, Math.min(ms.confidence, best.v <= KEEP_THRESHOLD ? 0.75 : 0.55));
  } else {
    ms.notes.push(`Observed ${stat.toUpperCase()} damage roughly fits the dex spread (±${priorV.toFixed(1)}%).`);
  }
}

function totalViolationDefense(
  gen: CalcGen,
  ms: MatchedSet,
  byKey: Map<string, MatchedSet>,
  evs: Partial<StatsTable>,
  obs: DamageObservation[],
): number {
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
  return n ? v / n : 0; // average per-observation
}

function refineDefense(
  gen: CalcGen,
  ms: MatchedSet,
  byKey: Map<string, MatchedSet>,
  stat: 'def' | 'spd',
  obs: DamageObservation[],
): void {
  const priorHp = ms.evs.hp || 0;
  const priorDef = ms.evs[stat] || 0;
  const priorV = totalViolationDefense(gen, ms, byKey, ms.evs, obs);
  if (priorV <= KEEP_THRESHOLD) {
    ms.confidence = Math.min(0.98, ms.confidence + 0.03);
    return;
  }
  const otherSum = evSumExcluding(ms.evs, ['hp', stat]);
  const hpCandidates = [...new Set([priorHp, 0, 248, 252])].filter((h) => h <= EV_MAX);
  let best = { hp: priorHp, ev: priorDef, v: priorV, score: priorV };
  for (const hp of hpCandidates) {
    for (let ev = 0; ev <= EV_MAX; ev += EV_STEP) {
      if (otherSum + hp + ev > EV_TOTAL) break;
      const v = totalViolationDefense(gen, ms, byKey, { ...ms.evs, hp, [stat]: ev }, obs);
      const dev = (Math.abs(hp - priorHp) + Math.abs(ev - priorDef)) / EV_MAX;
      const score = v + LAMBDA * dev;
      if (score < best.score - 1e-6) best = { hp, ev, v, score };
    }
  }
  if (best.v > RESIDUAL_ACCEPT) {
    ms.notes.push(
      `Damage taken doesn't cleanly fit any HP/${stat.toUpperCase()} spread (best residual ${best.v.toFixed(1)}%); keeping the dex spread.`,
    );
    ms.confidence = Math.max(0.3, ms.confidence - 0.1);
  } else if (best.hp !== priorHp || best.ev !== priorDef) {
    ms.evs = { ...ms.evs, hp: best.hp, [stat]: best.ev };
    ms.evSource = 'derived';
    ms.notes.push(
      `Derived HP/${stat.toUpperCase()} = ${best.hp}/${best.ev} EVs from damage taken (dex spread was off by ${priorV.toFixed(1)}%, residual ${best.v.toFixed(1)}%).`,
    );
    ms.confidence = Math.max(0.3, Math.min(ms.confidence, best.v <= KEEP_THRESHOLD ? 0.7 : 0.5));
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
const SELECT_MARGIN = 2.5;

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
