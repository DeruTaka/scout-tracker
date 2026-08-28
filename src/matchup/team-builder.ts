// Orchestrates the counter-team builder: resolve real sets for the opponent's
// threats, score every real, legal, actually-viable candidate species against
// them, blend in historical win-rate, evidence-quality, and real
// teammate-synergy signals, then assemble 6 picks via a best-first (A*-style)
// search over partial teams rather than pure greedy — each expansion is
// guided by f(node) = g(node) [realized coverage + viability + synergy so
// far] + h(node) [an optimistic estimate of the best remaining slots could
// add], so the search can look past a locally-strong-but-narrow pick in
// favor of a combination that covers the whole threat list better. Mandatory
// picks (Koraidon) and type-coverage requirements (Steel/Dark/Fairy) are
// enforced as hard constraints, not just scoring bonuses — see
// buildCounterTeam and enforceTypeRequirements.
import type { Generation, GenerationNum } from '@pkmn/data';
import type { Datastore } from '../store/datastore.js';
import type { MatchedSet } from '../types.js';
import { toID } from '../data/dex.js';
import type { ThreatProfile } from './threat-profile.js';
import { getBestKnownSet, getKnownSetVariants, fillRealisticSet, allCandidateSpecies, type KnownSet, type KnownSetSource } from './candidate-pool.js';
import { scoreMatchup, type MatchupResult } from './score.js';
import { getHistoricalWinRates, type WinRate } from './historical.js';
import { getUsageWeight, getUsageRankMap, getTeammateAffinity } from '../data/usage-provider.js';

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
  /** Type/Tera coverage requirements that could NOT be met (no legal,
   *  species-clause-compatible candidate was available) — normally empty. */
  unmetRequirements: string[];
}

const TEAM_SIZE = 6;
const HISTORY_WEIGHT = 0.6; // points per (winRate% - 50), scaled by sample confidence
const EVIDENCE_BONUS = 4; // small nudge for real store-derived sets over a Smogon fallback
// Rank-based, not raw-percent-based: usage% is heavily right-skewed (staples
// sit at 20-90%, everything else falls off a cliff under ~10%), so a linear
// weight on the raw percent barely separates rank 5 from rank 50. Scoring by
// how far inside the viability cutoff a candidate sits gives a much steeper,
// more decisive gradient — favoring genuine S/A-tier picks over a B--tier
// one long before matchup differences could ever outweigh it.
const VIABILITY_WEIGHT = 3;
const TEAMMATE_WEIGHT = 40; // points per unit of real teammate co-occurrence (0..1-ish) with an already-picked mon
const UNCOVERED_FLOOR = -100; // sentinel "this threat is entirely unaddressed" coverage level
// A stand-in for "B- rank and above" on a community Viability Rankings
// thread, since there's no VR thread to parse — Smogon's own gen9ubers chaos
// stats track ~200 species total, and Ubers is small/centralized enough that
// the top ~45 by real usage is a solid proxy for "actually played," not
// filler that happened to land a good calc.
const MAX_VIABILITY_RANK = 45;
// A candidate outside that rank cutoff (or untracked by Smogon at all) is
// still allowed through if it's a RECURRING local trend — this many separate
// real sightings in this app's own scouted games, not a single one-off. This
// does NOT exempt a candidate from the legality check below — a banned mon
// stays banned no matter how many old replays it appears in.
const MIN_LOCAL_RECURRENCE = 3;
const NODE_BUDGET = 8000; // hard cap on search expansions, so a huge candidate pool can't hang the request
const BRANCH_CAP = 10; // per node, only the top-N unpicked candidates by immediate marginal gain are explored
// Moves banned by clauses standard in every Ubers ruleset regardless of tier
// list — Baton Pass Clause and the OHKO Clause. Fixed rules, not usage data.
const BANNED_MOVES = new Set(['batonpass', 'fissure', 'guillotine', 'horndrill', 'sheercold']);
const MANDATORY_SPECIES = ['Koraidon'];
// Type-or-Tera coverage every real Ubers team is expected to carry, given how
// saturated the tier is with Fairy (Zacian-Crowned), Dragon, and Psychic
// threats. Steel is a plain type requirement (no Tera substitute) per the
// user's own teambuilding standard.
const TYPE_REQUIREMENTS: { type: string; allowTera: boolean }[] = [
  { type: 'Steel', allowTera: false },
  { type: 'Dark', allowTera: true },
  { type: 'Fairy', allowTera: true },
];

/** True if `sp` is legal for Ubers: not AG-banned (Ubers itself IS the tier
 *  restricted mons play in, but a small set of things are too strong even
 *  for THAT — e.g. Miraidon), not Illegal/CAP, and actually obtainable in
 *  this generation (isNonstandard null). Sourced from @pkmn/dex's own
 *  Smogon-tier data, not a hand-maintained banlist. */
function isTierLegal(sp: { tier?: string; isNonstandard?: string | null } | undefined): boolean {
  if (!sp) return false;
  if (sp.tier === 'AG' || sp.tier === 'Illegal' || sp.tier === 'CAP') return false;
  if (sp.isNonstandard) return false;
  return true;
}

function hasBannedMove(set: MatchedSet): boolean {
  return set.moves.some((m) => BANNED_MOVES.has(toID(m)));
}

function sampleConfidence(n: number): number {
  return Math.min(n / 5, 1);
}

function speciesTypes(gen: Generation, baseSpecies: string): string[] {
  const sp = gen.species.get(baseSpecies);
  return (sp?.types ?? []).map((t) => t.toLowerCase());
}

function satisfiesTypeRequirement(gen: Generation, pick: { set: MatchedSet }, req: { type: string; allowTera: boolean }): boolean {
  const t = req.type.toLowerCase();
  if (speciesTypes(gen, pick.set.baseSpecies).includes(t)) return true;
  if (req.allowTera && (pick.set.tera ?? '').toLowerCase() === t) return true;
  return false;
}

interface ScoredCandidate {
  idx: number; // this candidate's own position in the `scored` array — lets later passes (repair) do affinity/coverage lookups without re-searching
  species: string;
  set: MatchedSet;
  source: KnownSetSource;
  viability: number; // raw Smogon usage weight, 0 if untracked
  dexNum: number | undefined; // national dex number — Species Clause groups on this, not on forme name
  perThreat: Map<string, { result: MatchupResult; weight: number; threatSpecies: string }>;
  weightedSum: number; // this mon's own best-case weighted matchup total across every threat, independent of teammates
  qualityScore: number; // viability + history + evidence — intrinsic to the mon, not threat-specific
  standaloneCeiling: number; // qualityScore + weightedSum — the A* heuristic's per-candidate upper bound
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
  if (!resolvedThreats.length) return { threats, resolvedThreats, team: [], unmetRequirements: [] };

  const threatIds = new Set(resolvedThreats.map((t) => toID(t.set.baseSpecies)));
  const historicalWinRates = getHistoricalWinRates(store, formatid, threatIds);
  const candidateSpecies = await allCandidateSpecies(store, formatid);
  const genNum = gen.num as GenerationNum;
  const usageRanks = await getUsageRankMap(formatid);

  const scored: ScoredCandidate[] = [];

  /** Score one already-fetched real set for `species` against every
   *  resolved threat. Returns null if it fails legality or viability. */
  const scoreKnownSet = async (species: string, known: KnownSet): Promise<ScoredCandidate | null> => {
    const sp = gen.species.get(known.set.baseSpecies);
    if (!isTierLegal(sp)) return null; // e.g. Miraidon: tier 'AG', banned even from Ubers
    if (hasBannedMove(known.set)) return null; // Baton Pass / OHKO Clause

    const rank = usageRanks.get(toID(species));
    const viableByRank = rank !== undefined && rank <= MAX_VIABILITY_RANK;
    const viableLocally = known.source === 'store' && (known.localCount ?? 0) >= MIN_LOCAL_RECURRENCE;
    if (!viableByRank && !viableLocally) return null; // not actually played in this tier

    const viability = await getUsageWeight(formatid, species);
    const dexNum = sp?.num;

    const perThreat = new Map<string, { result: MatchupResult; weight: number; threatSpecies: string }>();
    let weightedSum = 0;
    for (const t of resolvedThreats) {
      const result = scoreMatchup(genNum, known.set, t.set);
      perThreat.set(toID(t.set.baseSpecies), { result, weight: t.weight, threatSpecies: t.species });
      weightedSum += t.weight * result.score;
    }

    const hr = historicalWinRates.get(toID(species));
    // weightedWinPercent already leans on more recent scouted games —
    // sampleConfidence still scales by the raw game count, since that's a
    // genuine sample-size signal independent of how recent those games were.
    const historyBonus = hr && hr.total ? HISTORY_WEIGHT * (hr.weightedWinPercent - 50) * sampleConfidence(hr.total) : 0;
    const evidenceBonus = known.source === 'store' ? EVIDENCE_BONUS : 0;
    // Rank 1 scores MAX_VIABILITY_RANK points, the cutoff itself scores ~0 —
    // a steep, decisive gradient (see VIABILITY_WEIGHT). A locally-recurring
    // pick with no Smogon rank at all gets a modest flat credit instead of 0,
    // since it cleared its own (stricter) bar.
    const viabilityScore = viableByRank ? (MAX_VIABILITY_RANK - rank! + 1) * VIABILITY_WEIGHT : VIABILITY_WEIGHT * 5;
    const qualityScore = viabilityScore + historyBonus + evidenceBonus;

    return {
      idx: -1, // assigned once pushed into `scored`
      species,
      set: known.set,
      source: known.source,
      viability,
      dexNum,
      perThreat,
      weightedSum,
      qualityScore,
      standaloneCeiling: qualityScore + weightedSum,
      rationale: buildRationale(perThreat, hr, known.source, viability, rank),
    };
  };

  const push = (c: ScoredCandidate | null) => {
    if (!c) return;
    c.idx = scored.length;
    scored.push(c);
  };

  // Mandatory picks first: evaluate every REAL variant of the species (not
  // just the single most-common build) and keep whichever actually answers
  // this threat list best — a mandatory pick shouldn't be locked to
  // "most popular" when a different real, evidenced spread/Tera/item choice
  // for the same species handles the real matchup better.
  const mandatoryIdx: number[] = [];
  for (const species of MANDATORY_SPECIES) {
    const variants = await getKnownSetVariants(store, gen, formatid, species);
    let best: ScoredCandidate | null = null;
    for (const rawKnown of variants) {
      const known = await fillRealisticSet(gen, formatid, rawKnown);
      const cand = await scoreKnownSet(species, known);
      if (cand && (!best || cand.standaloneCeiling > best.standaloneCeiling)) best = cand;
    }
    if (!best) {
      // No variant cleared legality/viability (shouldn't happen for a real
      // Ubers staple) — fall back to whatever's known at all, unfiltered,
      // rather than silently dropping a supposedly-mandatory pick.
      const rawKnown = await getBestKnownSet(store, gen, formatid, species);
      if (rawKnown) {
        const known = await fillRealisticSet(gen, formatid, rawKnown);
        best = await scoreKnownSet(species, known);
        if (!best) {
          const dexNum = gen.species.get(known.set.baseSpecies)?.num;
          best = {
            idx: -1, species, set: known.set, source: known.source, viability: 0, dexNum,
            perThreat: new Map(), weightedSum: 0, qualityScore: 0, standaloneCeiling: 0,
            rationale: ['Mandatory pick — no matchup/viability data available.'],
          };
        }
      }
    }
    if (best) {
      push(best);
      mandatoryIdx.push(best.idx);
    }
  }
  const mandatoryIds = new Set(mandatoryIdx.map((i) => toID(scored[i]!.species)));

  for (const species of candidateSpecies) {
    if (mandatoryIds.has(toID(species))) continue; // already scored above
    if (threatIds.has(toID(species))) continue; // don't recommend fielding the opponent's own top threats
    const rawKnown = await getBestKnownSet(store, gen, formatid, species);
    if (!rawKnown) continue;
    const known = await fillRealisticSet(gen, formatid, rawKnown);
    push(await scoreKnownSet(species, known));
  }

  const affinity = await buildAffinityMatrix(formatid, scored);
  const picked = searchTeam(scored, resolvedThreats, affinity, mandatoryIdx);
  const { team: repaired, unmet } = enforceTypeRequirements(picked, scored, gen, resolvedThreats, affinity);

  const team = repaired.map((c) => ({ species: c.species, set: c.set, source: c.source, rationale: c.rationale }));
  return { threats, resolvedThreats, team, unmetRequirements: unmet };
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
  hr: WinRate | undefined,
  source: KnownSetSource,
  viability: number,
  rank: number | undefined,
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
  if (rank !== undefined) notes.push(`#${rank} in real ${(viability * 100).toFixed(1)}% usage for this tier.`);
  else if (viability > 0) notes.push(`~${(viability * 100).toFixed(1)}% real usage in this tier.`);
  else notes.push('Not tracked by Smogon usage stats — kept only for its recurring local scouting history.');
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

/** Fold `idx` into `coverage`/`g`, returning the new node — shared by the
 *  mandatory-pick seeding step and the search's own expansion step so both
 *  compute a pick's contribution identically. */
function applyPick(node: SearchNode, idx: number, scored: ScoredCandidate[], affinity: Map<string, number>): SearchNode {
  const cand = scored[idx]!;
  const gain = coverageGain(cand, node.coverage);
  const newCoverage = new Map(node.coverage);
  for (const [id, { result }] of cand.perThreat) newCoverage.set(id, Math.max(newCoverage.get(id)!, result.score));
  return {
    pickedIdx: [...node.pickedIdx, idx],
    coverage: newCoverage,
    g: node.g + gain + cand.qualityScore + teammateBonus(idx, node.pickedIdx, affinity),
  };
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
  mandatoryIdx: number[],
): ScoredCandidate[] {
  if (!scored.length) return [];
  const threatIds = resolvedThreats.map((t) => toID(t.set.baseSpecies));
  const standaloneSorted = scored
    .map((c, idx) => ({ idx, value: c.standaloneCeiling }))
    .sort((a, b) => b.value - a.value);

  // Mandatory picks are seeded into the root node up front — the search
  // never gets a chance to "not" pick Koraidon, it only fills the remaining
  // slots around it.
  let start: SearchNode = { pickedIdx: [], coverage: new Map(threatIds.map((id) => [id, UNCOVERED_FLOOR])), g: 0 };
  for (const idx of mandatoryIdx) start = applyPick(start, idx, scored, affinity);

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
    // Species Clause: group on the national dex number, not the forme name —
    // Arceus-Ice and Arceus-Steel are still both "Arceus" as far as the
    // format's team-legality rules are concerned, so at most one dex number
    // can appear on the team even though every forme scores as a distinct
    // candidate everywhere else in this file.
    const pickedDexNums = new Set(node.pickedIdx.map((i) => scored[i]!.dexNum).filter((n): n is number => n !== undefined));
    const branchCandidates = scored
      .map((c, idx) => ({ idx, c }))
      .filter(({ idx, c }) => !pickedSet.has(idx) && !(c.dexNum !== undefined && pickedDexNums.has(c.dexNum)))
      .map(({ idx, c }) => ({
        idx,
        marginal: coverageGain(c, node.coverage) + c.qualityScore + teammateBonus(idx, node.pickedIdx, affinity),
      }))
      .sort((a, b) => b.marginal - a.marginal)
      .slice(0, BRANCH_CAP);

    for (const { idx } of branchCandidates) frontier.push(applyPick(node, idx, scored, affinity));
  }

  // Budget exhausted without a complete node popped (pathological/tiny pool)
  // — fall back to whatever partial frontier node has gone furthest.
  if (!best) {
    best = frontier.sort((a, b) => b.pickedIdx.length - a.pickedIdx.length || b.g - a.g)[0] ?? start;
  }

  return best.pickedIdx.map((idx) => scored[idx]!);
}

/**
 * Hard-constraint repair pass: the search optimizes for threat coverage and
 * doesn't know about type-requirement rules, so after it returns, swap in a
 * real, legal, Species-Clause-compatible replacement for any unmet
 * requirement (Steel / Dark-or-Tera / Fairy-or-Tera). The replaced slot is
 * always the current team's weakest, non-mandatory member that isn't itself
 * the ONLY thing satisfying some other still-relevant requirement — so
 * fixing one requirement never silently breaks another.
 */
function enforceTypeRequirements(
  picked: ScoredCandidate[],
  scored: ScoredCandidate[],
  gen: Generation,
  resolvedThreats: CounterTeamResult['resolvedThreats'],
  affinity: Map<string, number>,
): { team: ScoredCandidate[]; unmet: string[] } {
  const team = [...picked];
  const unmet: string[] = [];

  for (const req of TYPE_REQUIREMENTS) {
    if (team.some((p) => satisfiesTypeRequirement(gen, p, req))) continue;

    const pickedIds = new Set(team.map((p) => toID(p.species)));
    const pickedDexNums = new Set(team.map((p) => p.dexNum).filter((n): n is number => n !== undefined));
    const replacementOptions = scored
      .filter((c) => !pickedIds.has(toID(c.species)))
      .filter((c) => c.dexNum === undefined || !pickedDexNums.has(c.dexNum))
      .filter((c) => satisfiesTypeRequirement(gen, c, req))
      .map((c) => ({
        c,
        value: c.qualityScore + c.weightedSum + team.reduce((s, p) => s + TEAMMATE_WEIGHT * pairAffinity(affinity, c.idx, p.idx), 0),
      }))
      .sort((a, b) => b.value - a.value);

    if (!replacementOptions.length) {
      unmet.push(`${req.type}${req.allowTera ? ' (type or Tera)' : ''}`);
      continue;
    }

    const removable = team
      .map((p, i) => ({ p, i }))
      .filter(({ p }) => !MANDATORY_SPECIES.includes(p.species))
      .filter(({ p }) => {
        const otherReqs = TYPE_REQUIREMENTS.filter((r) => r !== req);
        // Never remove a member if it's the ONLY current pick satisfying
        // some other requirement.
        return !otherReqs.some((r) => satisfiesTypeRequirement(gen, p, r) && team.filter((q) => q !== p).every((q) => !satisfiesTypeRequirement(gen, q, r)));
      })
      .sort((a, b) => a.p.qualityScore + a.p.weightedSum - (b.p.qualityScore + b.p.weightedSum))[0];

    if (!removable) {
      unmet.push(`${req.type}${req.allowTera ? ' (type or Tera)' : ''}`);
      continue;
    }

    const replacement = replacementOptions[0]!.c;
    team[removable.i] = {
      ...replacement,
      rationale: [...replacement.rationale, `Added for required ${req.type} coverage.`],
    };
  }

  return { team, unmet };
}
