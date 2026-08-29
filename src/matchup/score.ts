// 1v1 damage-calc matchup heuristic between two arbitrary MatchedSets — no
// replay context (no weather/hazards/boosts to draw from), so this is
// deliberately simpler than engine.ts's buildPokemon/buildField (which carry
// replay-observation-specific baggage like the Intrepid Sword boost
// compensation). A heuristic favorability score, not a full battle sim.
import * as calc from '@smogon/calc';
import type { GenerationNum } from '@pkmn/data';
import type { MatchedSet } from '../types.js';

type CalcGen = ReturnType<typeof calc.Generations.get>;

function toID(s: string | undefined): string {
  return ('' + (s ?? '')).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function buildBarePokemon(gen: CalcGen, ms: MatchedSet): calc.Pokemon | null {
  try {
    const p = new calc.Pokemon(gen, ms.baseSpecies, {
      level: ms.level || 100,
      item: ms.item || undefined,
      ability: ms.ability || undefined,
      nature: ms.nature || 'Serious',
      evs: ms.evs,
      ivs: ms.ivs,
      teraType: gen.num >= 9 && ms.tera ? (ms.tera as any) : undefined,
    });
    if (!p.species || !(p.species as any).baseStats) return null;
    return p;
  } catch {
    return null;
  }
}

/** Raw EV/IV/nature Speed, plus the one item modifier engine.ts's own speed
 *  derivation already accounts for (Choice Scarf) — full item-speed-mod
 *  coverage (Iron Ball, Quick Powder, ...) is out of v1 scope. */
function effectiveSpeed(p: calc.Pokemon, item: string | undefined): number {
  return p.rawStats.spe * (toID(item).startsWith('choicescarf') ? 1.5 : 1);
}

function hasTrickRoom(set: MatchedSet): boolean {
  return set.moves.some((m) => toID(m) === 'trickroom');
}

interface HitResult {
  pct: number; // best move's max-roll damage, as % of defender's max HP
  guaranteedOhko: boolean; // even the WORST roll of that move KOs
  guaranteed2hko: boolean; // even the worst roll clears 50% (two hits always KO)
}

function bestHit(gen: CalcGen, attacker: calc.Pokemon, defender: calc.Pokemon, moves: string[], field: calc.Field): HitResult {
  const max = defender.maxHP();
  if (!max) return { pct: 0, guaranteedOhko: false, guaranteed2hko: false };
  let bestPct = 0;
  let bestLoPct = 0;
  for (const moveName of moves) {
    try {
      const move = new calc.Move(gen, moveName);
      if (move.category === 'Status') continue;
      const res = calc.calculate(gen, attacker, defender, move, field);
      const [lo, hi] = res.range();
      const hiPct = (hi / max) * 100;
      if (hiPct > bestPct) {
        bestPct = hiPct;
        bestLoPct = (lo / max) * 100;
      }
    } catch {
      /* unresolvable move (bad data, gen mismatch) — skip it */
    }
  }
  return { pct: bestPct, guaranteedOhko: bestLoPct >= 100, guaranteed2hko: bestLoPct >= 50 };
}

export interface MatchupResult {
  score: number; // positive favors the candidate, negative favors the threat
  candidateDamagePercent: number;
  threatDamagePercent: number;
  candidateFaster: boolean; // literal speed-check result, ignoring Trick Room
  candidateActsFirst: boolean; // candidateFaster, OR candidate runs Trick Room
  candidateNaturallyFaster: boolean; // wins the speed check WITHOUT its own Choice Scarf
  candidateOhko: boolean;
  candidateGuaranteed2hko: boolean;
  threatOhko: boolean;
  threatGuaranteed2hko: boolean;
}

const NEUTRAL: MatchupResult = {
  score: 0,
  candidateDamagePercent: 0,
  threatDamagePercent: 0,
  candidateFaster: false,
  candidateActsFirst: false,
  candidateNaturallyFaster: false,
  candidateOhko: false,
  candidateGuaranteed2hko: false,
  threatOhko: false,
  threatGuaranteed2hko: false,
};

const SPEED_BONUS = 15;
const NATURAL_SPEED_BONUS_MULT = 1.3; // extra credit for winning speed without needing its own Choice Scarf
const OHKO_BONUS = 20;
const TWOHKO_BONUS = 8;
// A big hit that can't actually be landed safely — the attacker is slower,
// isn't running Trick Room, and would eat the threat's own hit first — is
// still worth SOMETHING (it might survive and land it next turn, or the
// threat might not have picked the "kill first" line), but nowhere near as
// much as a hit that's a sure thing. A real example: Shaymin-Sky can 1-shot
// Pheromosa on paper, but without a Scarf or a setup turn it's slower and
// gets hit first — that "OHKO" isn't the same kind of asset as Pheromosa's
// own naturally-faster Triple Axel into Rayquaza.
const UNSAFE_HIT_DISCOUNT = 0.35;

/** How favorably `candidate` matches up into `threat`, one-on-one, on a
 *  neutral field. Combines best-move damage in both directions with bonuses
 *  for a guaranteed OHKO/2HKO and for winning the speed check — discounted
 *  when winning that KO requires actually going first and the attacker can't
 *  guarantee that (Trick Room is the one exception: its whole point is
 *  embracing being slow, so a Trick Room user's own damage output is never
 *  discounted for lacking raw speed). A documented heuristic, not a full
 *  turn-by-turn simulation. */
export function scoreMatchup(genNum: GenerationNum, candidate: MatchedSet, threat: MatchedSet): MatchupResult {
  const gen = calc.Generations.get(genNum);
  const field = new calc.Field({});
  const c = buildBarePokemon(gen, candidate);
  const t = buildBarePokemon(gen, threat);
  if (!c || !t) return NEUTRAL;

  const cHit = bestHit(gen, c, t, candidate.moves, field);
  const tHit = bestHit(gen, t, c, threat.moves, field);

  const cEffSpeed = effectiveSpeed(c, candidate.item);
  const tEffSpeed = effectiveSpeed(t, threat.item);
  const candidateFaster = cEffSpeed > tEffSpeed;
  const candidateTrickRoom = hasTrickRoom(candidate);
  const threatTrickRoom = hasTrickRoom(threat);
  const candidateActsFirst = candidateTrickRoom || candidateFaster;
  const threatActsFirst = threatTrickRoom || !candidateFaster;
  const candidateNaturallyFaster = c.rawStats.spe > tEffSpeed;

  let score = cHit.pct - tHit.pct;
  if (cHit.guaranteedOhko) score += OHKO_BONUS * (candidateActsFirst ? 1 : UNSAFE_HIT_DISCOUNT);
  else if (cHit.guaranteed2hko) score += TWOHKO_BONUS * (candidateActsFirst ? 1 : UNSAFE_HIT_DISCOUNT);
  if (tHit.guaranteedOhko) score -= OHKO_BONUS * (threatActsFirst ? 1 : UNSAFE_HIT_DISCOUNT);
  else if (tHit.guaranteed2hko) score -= TWOHKO_BONUS * (threatActsFirst ? 1 : UNSAFE_HIT_DISCOUNT);

  if (candidateActsFirst) {
    score += candidateTrickRoom || candidateNaturallyFaster ? SPEED_BONUS * NATURAL_SPEED_BONUS_MULT : SPEED_BONUS;
  } else {
    score -= SPEED_BONUS;
  }

  return {
    score,
    candidateDamagePercent: cHit.pct,
    threatDamagePercent: tHit.pct,
    candidateFaster,
    candidateActsFirst,
    candidateNaturallyFaster,
    candidateOhko: cHit.guaranteedOhko,
    candidateGuaranteed2hko: cHit.guaranteed2hko,
    threatOhko: tHit.guaranteedOhko,
    threatGuaranteed2hko: tHit.guaranteed2hko,
  };
}
