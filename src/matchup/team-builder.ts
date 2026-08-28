// Orchestrates the counter-team builder: resolve real sets for the opponent's
// threats, score every real, actually-viable candidate species against them,
// blend in historical win-rate, evidence-quality, and real teammate-synergy
// signals, then assemble 6 picks via a best-first (A*-style) search over
// partial teams rather than pure greedy — each expansion is guided by
// f(node) = g(node) [realized coverage + viability + synergy so far] +
// h(node) [an optimistic estimate of the best remaining slots could add],
// so the search can look past a locally-strong-but-narrow pick in favor of a
// combination that covers the whole threat list better.
import type { Generation, GenerationNum } from '@pkmn/data';
import type { Datastore } from '../store/datastore.js';
import type { MatchedSet } from '../types.js';
import { toID } from '../data/dex.js';
import type { ThreatProfile } from './threat-profile.js';
import { getBestKnownSet, allCandidateSpecies, type KnownSetSource } from './candidate-pool.js';
import { scoreMatchup, type MatchupResult } from './score.js';
import { getHistoricalWinRates } from './historical.js';
import { getUsageWeight, getTeammateAffinity } from '../data/usage-provider.js';

export interface TeamPick {
  species: string;
  set: MatchedSet;
  source: KnownSetSource;
  rationale: string[];
}

export interface CounterTeamResult {
  threats: ThreatProfile;
  resolvedThreats: { species: string; weight: number; set: MatchedSet; source: KnownSetSource }[];
  team: TeamPick[];
}

const TEAM_SIZE = 6;
const HISTORY_WEIGHT = 0.6; // points per (winRate% - 50), scaled by sample confidence
const EVIDENCE_BONUS = 4; // small nudge for real store-derived sets over a Smogon fallback
const VIABILITY_WEIGHT = 0.5; // points per "usage percent" point — keeps real staples ahead of matchup-only overfits
const TEAMMATE_WEIGHT = 40; // points per unit of real teammate co-occurrence (0..1-ish) with an already-picked mon
const UNCOVERED_FLOOR = -100; // sentinel "this threat is entirely unaddressed" coverage level
// Below this real-metagame usage weight, a Smogon-fallback candidate is
// noise, not a real pick — this is what keeps a barely-played mon with a
// lucky damage matchup (e.g. something sitting at 0.03% usage) out of the
// team just because it happens to OHKO one threat. Locally-scouted (`store`)
// candidates skip this floor entirely: something this app has actually seen
// played in real games IS real, whatever the global Smogon number says.
const MIN_SMOGON_VIABILITY = 0.01;
const NODE_BUDGET = 8000; // hard cap on search expansions, so a huge candidate pool can't hang the request
const BRANCH_CAP = 10; // per node, only the top-N unpicked candidates by immediate marginal gain are explored

function sampleConfidence(n: number): number {
  return Math.min(n / 5, 1);
}

interface ScoredCandidate {
  species: string;
  set: MatchedSet;
  source: KnownSetSource;
  viability: number; // raw Smogon usage weight, 0 if untracked
  perThreat: Map<string, { result: MatchupResult; weight: number; threatSpecies: string }>;
  qualityScore: number; // viability + history + evidence — intrinsic to the mon, not threat-specific
  standaloneCeiling: number; // qualityScore + this mon's own best-case weighted matchup total — the A* heuristic's per-candidate upper bound
  rationale: string[];
}

export async function buildCounterTeam(
  store: Datastore,
  gen: Generation,
  formatid: string,
  threats: ThreatProfile,
): Promise<CounterTeamResult> {
  const resolvedThreats: CounterTeamResult['resolvedThreats'] = [];
  for (const t of threats.threats) {
    const known = await getBestKnownSet(store, gen, formatid, t.baseSpecies);
    if (known) resolvedThreats.push({ species: t.species, weight: t.weight, set: known.set, source: known.source });
  }
  if (!resolvedThreats.length) return { threats, resolvedThreats, team: [] };

  const threatIds = new Set(resolvedThreats.map((t) => toID(t.set.baseSpecies)));
  const historicalWinRates = getHistoricalWinRates(store, formatid, threatIds);

  const candidateSpecies = await allCandidateSpecies(store, formatid);
  const genNum = gen.num as GenerationNum;

  const scored: ScoredCandidate[] = [];
  for (const species of candidateSpecies) {
    if (threatIds.has(toID(species))) continue; // don't recommend fielding the opponent's own top threats
    const known = await getBestKnownSet(store, gen, formatid, species);
    if (!known) continue;

    const viability = await getUsageWeight(formatid, species);
    if (known.source !== 'store' && viability < MIN_SMOGON_VIABILITY) continue; // not a real pick in this tier

    const perThreat = new Map<string, { result: MatchupResult; weight: number; threatSpecies: string }>();
    let weightedSum = 0;
    for (const t of resolvedThreats) {
      const result = scoreMatchup(genNum, known.set, t.set);
      perThreat.set(toID(t.set.baseSpecies), { result, weight: t.weight, threatSpecies: t.species });
      weightedSum += t.weight * result.score;
    }

    const hr = historicalWinRates.get(toID(species));
    const historyBonus = hr && hr.total ? HISTORY_WEIGHT * ((hr.wins / hr.total) * 100 - 50) * sampleConfidence(hr.total) : 0;
    const evidenceBonus = known.source === 'store' ? EVIDENCE_BONUS : 0;
    const qualityScore = viability * 100 * VIABILITY_WEIGHT + historyBonus + evidenceBonus;

    scored.push({
      species,
      set: known.set,
      source: known.source,
      viability,
      perThreat,
      qualityScore,
      standaloneCeiling: qualityScore + weightedSum,
      rationale: buildRationale(perThreat, hr, known.source, viability),
    });
  }

  const affinity = await buildAffinityMatrix(formatid, scored);
  const team = searchTeam(scored, resolvedThreats, affinity);
  return { threats, resolvedThreats, team };
}

/** Precompute real teammate co-occurrence for every candidate pair up front
 *  (all reads hit the same already-cached Smogon chaos data after the first
 *  call, so this is fast) — keeps the search loop itself fully synchronous. */
async function buildAffinityMatrix(formatid: string, scored: ScoredCandidate[]): Promise<Map<string, number>> {
  const m = new Map<string, number>();
  for (let i = 0; i < scored.length; i++) {
    for (let j = i + 1; j < scored.length; j++) {
      const a = await getTeammateAffinity(formatid, scored[i]!.species, scored[j]!.species);
      const b = await getTeammateAffinity(formatid, scored[j]!.species, scored[i]!.species);
      const affinity = Math.max(a, b);
      if (affinity > 0) m.set(`${i}|${j}`, affinity);
    }
  }
  return m;
}

function pairAffinity(affinity: Map<string, number>, i: number, j: number): number {
  const key = i < j ? `${i}|${j}` : `${j}|${i}`;
  return affinity.get(key) ?? 0;
}

function buildRationale(
  perThreat: Map<string, { result: MatchupResult; weight: number; threatSpecies: string }>,
  hr: { wins: number; total: number } | undefined,
  source: KnownSetSource,
  viability: number,
): string[] {
  const notes: string[] = [];
  const ranked = [...perThreat.values()].sort((a, b) => b.result.score - a.result.score);
  const notable = ranked.filter((v) => v.result.score > 10).slice(0, 2);
  const best = notable.length ? notable : ranked.slice(0, 1);
  for (const { result, weight, threatSpecies } of best) {
    const bits: string[] = [];
    if (result.candidateOhko) bits.push('OHKOs');
    else if (result.candidateGuaranteed2hko) bits.push('guaranteed 2HKO');
    if (result.candidateFaster) bits.push('outspeeds');
    const lead = notable.length ? 'Strong into' : 'Best available matchup:';
    notes.push(`${lead} ${threatSpecies} (${weight.toFixed(0)}% usage)${bits.length ? ' — ' + bits.join(', ') : ''}.`);
  }
  if (viability > 0) notes.push(`~${(viability * 100).toFixed(1)}% real usage in this tier.`);
  if (hr && hr.total >= 2) {
    notes.push(`Historically ${hr.wins}-${hr.total - hr.wins} in scouted games vs. cores with 2+ of these threats.`);
  }
  if (source !== 'store') {
    notes.push(`No local scouting data for this species — using ${source === 'usage' ? 'Smogon usage stats' : "Smogon's dex analysis"} instead.`);
  }
  return notes;
}

interface SearchNode {
  pickedIdx: number[];
  coverage: Map<string, number>;
  g: number;
}

/** How much team-wide weighted coverage adding `idx` gains over `coverage`. */
function coverageGain(cand: ScoredCandidate, coverage: Map<string, number>): number {
  let gain = 0;
  for (const [id, { result, weight }] of cand.perThreat) {
    const cur = coverage.get(id)!;
    gain += weight * (Math.max(cur, result.score) - cur);
  }
  return gain;
}

function teammateBonus(idx: number, pickedIdx: number[], affinity: Map<string, number>): number {
  let bonus = 0;
  for (const p of pickedIdx) bonus += TEAMMATE_WEIGHT * pairAffinity(affinity, idx, p);
  return bonus;
}

/** Optimistic (not rigorously admissible, but deliberately generous) estimate
 *  of the best value the remaining slots could still add: the sum of the
 *  TOP-`remainingSlots` unpicked candidates' own standalone ceilings. Real
 *  achievable coverage gain from several picks overlaps (coverage is a max,
 *  not a sum), so this can over-estimate — which is fine for a best-first
 *  search meant to explore combinations greedy wouldn't, not for a
 *  textbook-optimal guarantee.
 *
 *  Coverage saturates in practice — the 2nd, 3rd, ... remaining slot's real
 *  contribution shrinks once the strongest threats are already well-covered
 *  by earlier picks, but summing independent per-candidate ceilings has no
 *  way to know that. Left undamped, that inflates shallow (many-slots-left)
 *  nodes' f-score far above genuinely-deep, mostly-complete ones, so the
 *  search burns its node budget breadth-exploring instead of finishing a
 *  team. A geometric decay per remaining slot both approximates the real
 *  diminishing returns and keeps the search biased toward depth. */
const REMAINING_SLOT_DECAY = 0.55;

function heuristic(node: SearchNode, standaloneSorted: { idx: number; value: number }[]): number {
  const remaining = TEAM_SIZE - node.pickedIdx.length;
  if (remaining <= 0) return 0;
  const pickedSet = new Set(node.pickedIdx);
  let h = 0;
  let count = 0;
  let decay = 1;
  for (const c of standaloneSorted) {
    if (count >= remaining) break;
    if (pickedSet.has(c.idx)) continue;
    h += c.value * decay;
    decay *= REMAINING_SLOT_DECAY;
    count++;
  }
  return h;
}

function searchTeam(
  scored: ScoredCandidate[],
  resolvedThreats: CounterTeamResult['resolvedThreats'],
  affinity: Map<string, number>,
): TeamPick[] {
  if (!scored.length) return [];
  const threatIds = resolvedThreats.map((t) => toID(t.set.baseSpecies));
  const standaloneSorted = scored
    .map((c, idx) => ({ idx, value: c.standaloneCeiling }))
    .sort((a, b) => b.value - a.value);

  const startCoverage = new Map(threatIds.map((id) => [id, UNCOVERED_FLOOR]));
  const start: SearchNode = { pickedIdx: [], coverage: startCoverage, g: 0 };

  // Simple array-based priority queue (find-max-then-remove): at this
  // problem's scale (a few hundred candidates, a team of 6, budgeted node
  // count) a real binary heap buys nothing observable and this stays easy
  // to follow.
  let frontier: SearchNode[] = [start];
  let best: SearchNode | null = null;
  let expansions = 0;

  while (frontier.length && expansions < NODE_BUDGET) {
    let bestI = 0;
    let bestF = -Infinity;
    for (let i = 0; i < frontier.length; i++) {
      const f = frontier[i]!.g + heuristic(frontier[i]!, standaloneSorted);
      if (f > bestF) {
        bestF = f;
        bestI = i;
      }
    }
    const node = frontier.splice(bestI, 1)[0]!;
    expansions++;

    if (node.pickedIdx.length >= TEAM_SIZE) {
      best = node;
      break; // first complete team popped off the best-first frontier
    }

    const pickedSet = new Set(node.pickedIdx);
    const branchCandidates = scored
      .map((c, idx) => ({ idx, c }))
      .filter(({ idx }) => !pickedSet.has(idx))
      .map(({ idx, c }) => ({
        idx,
        marginal: coverageGain(c, node.coverage) + c.qualityScore + teammateBonus(idx, node.pickedIdx, affinity),
      }))
      .sort((a, b) => b.marginal - a.marginal)
      .slice(0, BRANCH_CAP);

    for (const { idx } of branchCandidates) {
      const cand = scored[idx]!;
      const gain = coverageGain(cand, node.coverage);
      const newCoverage = new Map(node.coverage);
      for (const [id, { result }] of cand.perThreat) {
        newCoverage.set(id, Math.max(newCoverage.get(id)!, result.score));
      }
      frontier.push({
        pickedIdx: [...node.pickedIdx, idx],
        coverage: newCoverage,
        g: node.g + gain + cand.qualityScore + teammateBonus(idx, node.pickedIdx, affinity),
      });
    }
  }

  // Budget exhausted without a complete node popped (pathological/tiny pool)
  // — fall back to whatever partial frontier node has gone furthest.
  if (!best) {
    best = frontier.sort((a, b) => b.pickedIdx.length - a.pickedIdx.length || b.g - a.g)[0] ?? start;
  }

  return best.pickedIdx.map((idx) => {
    const c = scored[idx]!;
    return { species: c.species, set: c.set, source: c.source, rationale: c.rationale };
  });
}
