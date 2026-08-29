// Orchestrates the counter-team builder: resolve real sets for the opponent's
// threats, score every real, legal, actually-viable candidate species against
// them, blend in historical win-rate, evidence-quality, and real
// teammate-synergy signals, then assemble 6 picks via a best-first (A*-style)
// search over partial teams rather than pure greedy — each expansion is
// guided by f(node) = g(node) [realized coverage + viability + synergy so
// far] + h(node) [an optimistic estimate of the best remaining slots could
// add], so the search can look past a locally-strong-but-narrow pick in
// favor of a combination that covers the whole threat list better. Mandatory
// picks and coverage requirements are per-format (see tier-config.ts) and
// enforced as hard constraints, not just scoring bonuses — see
// buildCounterTeam and enforceRequirements.
import type { Generation, GenerationNum } from '@pkmn/data';
import type { Datastore } from '../store/datastore.js';
import type { MatchedSet } from '../types.js';
import { toID, speciesMeta } from '../data/dex.js';
import type { ThreatProfile } from './threat-profile.js';
import { getBestKnownSet, getKnownSetVariants, fillRealisticSet, allCandidateSpecies, type KnownSet, type KnownSetSource } from './candidate-pool.js';
import { scoreMatchup, type MatchupResult } from './score.js';
import { getHistoricalWinRates, type WinRate } from './historical.js';
import { getUsageWeight, getUsageRankMap, getTeammateAffinity } from '../data/usage-provider.js';
import { getTierConfig, type Requirement } from './tier-config.js';
import { fetchLiveVrMap, VR_TIER_SCORE } from './vr-thread.js';

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
  /** Requirements that could NOT be met (no legal, Species-Clause-compatible
   *  candidate was available) — normally empty. */
  unmetRequirements: string[];
}

const TEAM_SIZE = 6;
const HISTORY_WEIGHT = 0.6; // points per (winRate% - 50), scaled by sample confidence
const EVIDENCE_BONUS = 4; // small nudge for real store-derived sets over a Smogon fallback
const TEAMMATE_WEIGHT = 40; // points per unit of real teammate co-occurrence (0..1-ish) with an already-picked mon
const UNCOVERED_FLOOR = -100; // sentinel "this threat is entirely unaddressed" coverage level
// A candidate that doesn't clear its tier's viability bar (usage rank or VR
// tier — see tier-config.ts) is still allowed through if it's a RECURRING
// local trend — this many separate real sightings in this app's own scouted
// games, not a single one-off. This does NOT exempt a candidate from the
// legality check below — a banned mon stays banned no matter how many old
// replays it appears in.
const MIN_LOCAL_RECURRENCE = 3;
// A pasted usage table can legitimately be a full Smogon stats dump —
// hundreds of rows down into <1% usage. Every extra threat multiplies the
// real damage-calc work below (one scoreMatchup call per candidate per
// threat) and the size of every search node's coverage map, so beyond a
// generous head of the real, meaningfully-used metagame the tail just isn't
// worth the cost — a mon a handful of games ever used can't materially
// change which 6 real counters get picked. threats.threats is already
// sorted by weight desc (see threat-profile.ts), so this keeps the biggest
// threats and drops the long tail.
const MAX_THREATS = 40;
const NODE_BUDGET = 8000; // hard cap on search expansions, so a huge candidate pool can't hang the request
const BRANCH_CAP = 10; // per node, only the top-N unpicked candidates by immediate marginal gain are explored
// Best-first search frontier nodes are cheap individually, but with no cap
// the frontier can retain tens of thousands of them by the time NODE_BUDGET
// is exhausted (each expansion nets +[BRANCH_CAP-1]), and each one carries a
// coverage map sized to the threat count — that combination is exactly what
// blew the process heap in practice (real, differentiated matchup scores
// plus a large threat list stall the depth-biased heuristic's usual fast
// convergence to a full 6-mon node). Pruning the frontier back to its best
// FRONTIER_CAP nodes after every expansion bounds retained memory
// regardless of candidate/threat count — standard beam-search practice —
// without changing which team a small/medium search would have found,
// since it only discards nodes that were already losing on f-score.
const FRONTIER_CAP = 500;
// A mandatory pick's own hazard move can accidentally "hog" that role and
// hazard-dedup-block a genuinely better teammate elsewhere (a real example:
// Groudon-Primal's Stealth Rock set blocking a Glimmora pick that would
// otherwise round out a Poison-requirement-satisfying team). Real
// teambuilding practice runs the opposite way — the mandatory mon switches
// to an attacking set (Swords Dance / Rock Polish) specifically BECAUSE
// something else handles rocks. So a hazard-carrying mandatory variant only
// gets kept over a non-hazard one when it clears it by more than this
// margin — "meaningfully better," not just nominally top-scoring.
const MANDATORY_HAZARD_FLEX_MARGIN = 15;
// Moves banned by clauses standard in every Ubers-family ruleset regardless
// of tier list — Baton Pass Clause and the OHKO Clause. Fixed rules, not
// usage data.
const BANNED_MOVES = new Set(['batonpass', 'fissure', 'guillotine', 'horndrill', 'sheercold']);
// Entry hazards don't stack across setters the way it'd take to justify a
// second moveslot spent on the same one: Stealth Rock only ever has one
// layer no matter who sets it, and a single Toxic Spikes/Spikes setter can
// already lay both/all of its own layers by staying in two or three turns.
// A second team member carrying the identical hazard move is a wasted slot,
// not real redundancy — at most one pick may carry each.
const HAZARD_MOVES = new Set(['stealthrock', 'spikes', 'toxicspikes', 'stickyweb', 'steelsurge']);

/** True if `sp` is legal: not AG-banned (a tier's own restricted-Pokemon
 *  format IS the tier those mons play in, but a small set of things are too
 *  strong even for that — e.g. Miraidon in Ubers), not Illegal/CAP, and
 *  actually obtainable in this generation. Sourced from @pkmn/dex's own
 *  Smogon-tier data, not a hand-maintained banlist — but that data only
 *  exists for species the CURRENT gen's regional dex carries, so this is
 *  skipped entirely for tiers whose viability comes from a curated list
 *  instead (see tier-config.ts's trustCuratedLegality): a National Dex-only
 *  species like Marshadow has no 'tier'/isNonstandard data to check against
 *  in the first place, and its presence on that curated list already means
 *  "legal and worth using" for that tier. */
function isTierLegal(sp: { tier?: string; isNonstandard?: string | null } | undefined): boolean {
  if (!sp) return false;
  if (sp.tier === 'AG' || sp.tier === 'Illegal' || sp.tier === 'CAP') return false;
  if (sp.isNonstandard) return false;
  return true;
}

function hasBannedMove(set: MatchedSet): boolean {
  return set.moves.some((m) => BANNED_MOVES.has(toID(m)));
}

function hazardMovesOf(set: MatchedSet): string[] {
  return set.moves.map(toID).filter((m) => HAZARD_MOVES.has(m));
}

function sampleConfidence(n: number): number {
  return Math.min(n / 5, 1);
}

/**
 * Choose a mandatory pick's build from its real, already-scored variants —
 * preferring the single best-scoring one, UNLESS it carries a hazard move
 * and a non-hazard variant scores within MANDATORY_HAZARD_FLEX_MARGIN of
 * it. A mandatory pick that happens to also be a real hazard-setter can
 * otherwise "hog" that role and hazard-dedup-block a genuinely better
 * teammate later (e.g. Groudon-Primal's Stealth Rock set blocking a
 * Glimmora pick that would otherwise round out the team) — real
 * teambuilding runs the opposite way, switching the mandatory mon to an
 * attacking set (Swords Dance / Rock Polish) specifically BECAUSE something
 * else already covers hazards. Exported as its own pure function (only
 * needs `.set`/`.standaloneCeiling`, no store/network access) so this
 * decision is unit-testable without pulling in real Smogon variant data.
 */
export function pickBestMandatoryVariant<T extends { set: MatchedSet; standaloneCeiling: number }>(candidates: T[]): T | null {
  let best: T | null = null;
  let bestNoHazard: T | null = null;
  for (const cand of candidates) {
    if (!best || cand.standaloneCeiling > best.standaloneCeiling) best = cand;
    if (!hazardMovesOf(cand.set).length && (!bestNoHazard || cand.standaloneCeiling > bestNoHazard.standaloneCeiling)) bestNoHazard = cand;
  }
  if (best && bestNoHazard && hazardMovesOf(best.set).length && bestNoHazard.standaloneCeiling >= best.standaloneCeiling - MANDATORY_HAZARD_FLEX_MARGIN) {
    return bestNoHazard;
  }
  return best;
}

interface ScoredCandidate {
  idx: number; // this candidate's own position in the `scored` array — lets later passes (repair) do affinity/coverage lookups without re-searching
  species: string;
  set: MatchedSet;
  source: KnownSetSource;
  viability: number; // raw Smogon usage weight, 0 if untracked (display only)
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
  /** Injectable for tests, so a VR-driven tier's live fetch can be stubbed
   *  with a fixture instead of hitting the real network. Defaults to the
   *  global fetch, same as every other network call in this app. */
  vrFetchImpl: typeof fetch = fetch,
): Promise<CounterTeamResult> {
  const config = getTierConfig(formatid);

  const resolvedThreats: CounterTeamResult['resolvedThreats'] = [];
  for (const t of threats.threats.slice(0, MAX_THREATS)) {
    const known = await getBestKnownSet(store, gen, formatid, t.baseSpecies);
    if (known) resolvedThreats.push({ species: t.species, weight: t.weight, set: known.set, source: known.source });
  }
  if (!resolvedThreats.length) return { threats, resolvedThreats, team: [], unmetRequirements: [] };

  const threatIds = new Set(resolvedThreats.map((t) => toID(t.set.baseSpecies)));
  const historicalWinRates = getHistoricalWinRates(store, formatid, threatIds);
  const genNum = gen.num as GenerationNum;
  const usageRanks = await getUsageRankMap(formatid);

  // A VR-driven tier restricts the ENTIRE candidate pool to that list —
  // fetched fresh every call (see vr-thread.ts, which already retries a
  // transient failure a couple of times), never a stored snapshot. Nothing
  // outside it is usable here, no matter how common it is locally or in
  // Smogon's usage stats, so this replaces allCandidateSpecies() entirely
  // rather than adding to it. If the fetch still fails after retrying, fail
  // loudly here rather than quietly proceeding with an empty pool — that
  // silent path used to surface as every single coverage requirement
  // failing at once ("no legal option was available"), which reads like a
  // real teambuilding problem instead of the network hiccup it actually is.
  const vrFetch = config.vrThreadUrl ? await fetchLiveVrMap(gen, config.vrThreadUrl, vrFetchImpl) : { map: null, reason: null };
  const vrMap = vrFetch.map;
  if (config.vrThreadUrl && !vrMap) {
    throw new Error(
      `Couldn't fetch the live Viability Rankings list for ${formatid} (${config.vrThreadUrl}): ${vrFetch.reason}. Try again in a moment.`,
    );
  }
  const candidateSpecies = config.vrThreadUrl
    ? Object.entries(vrMap ?? {})
        .filter(([, tier]) => VR_TIER_SCORE[tier] > 0)
        .map(([species]) => species)
    : await allCandidateSpecies(store, formatid, config.extraCandidateSpecies);

  const scored: ScoredCandidate[] = [];

  /** Score one already-fetched real set for `species` against every
   *  resolved threat. Returns null if it fails legality or viability. */
  const scoreKnownSet = async (species: string, known: KnownSet): Promise<ScoredCandidate | null> => {
    const meta = speciesMeta(gen, known.set.baseSpecies);
    if (config.trustCuratedLegality !== true) {
      const sp = gen.species.get(known.set.baseSpecies);
      if (!isTierLegal(sp)) return null; // e.g. Miraidon: tier 'AG', banned even from Ubers
    }
    if (hasBannedMove(known.set)) return null; // Baton Pass / OHKO Clause

    const viability = config.getViability(species, { usageRanks, vrMap });
    const viableLocally = known.source === 'store' && (known.localCount ?? 0) >= MIN_LOCAL_RECURRENCE;
    if (!viability.passes && !viableLocally) return null; // not actually played in this tier

    const usageWeight = await getUsageWeight(formatid, species);
    const dexNum = meta?.num;

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
    const qualityScore = viability.score + historyBonus + evidenceBonus;

    return {
      idx: -1, // assigned once pushed into `scored`
      species,
      set: known.set,
      source: known.source,
      viability: usageWeight,
      dexNum,
      perThreat,
      weightedSum,
      qualityScore,
      standaloneCeiling: qualityScore + weightedSum,
      rationale: buildRationale(perThreat, hr, known.source, viability.label),
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
  for (const species of config.mandatorySpecies) {
    const variants = await getKnownSetVariants(store, gen, formatid, species);
    const candidates: ScoredCandidate[] = [];
    for (const rawKnown of variants) {
      const known = await fillRealisticSet(gen, formatid, rawKnown);
      const cand = await scoreKnownSet(species, known);
      if (cand) candidates.push(cand);
    }
    let best = pickBestMandatoryVariant(candidates);
    if (!best) {
      // No variant cleared legality/viability (shouldn't happen for a real
      // tier staple) — fall back to whatever's known at all, unfiltered,
      // rather than silently dropping a supposedly-mandatory pick.
      const rawKnown = await getBestKnownSet(store, gen, formatid, species);
      if (rawKnown) {
        const known = await fillRealisticSet(gen, formatid, rawKnown);
        best = await scoreKnownSet(species, known);
        if (!best) {
          const dexNum = speciesMeta(gen, known.set.baseSpecies)?.num;
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
  const { team: repaired, unmet } = enforceRequirements(picked, scored, gen, config.requirements, config.mandatorySpecies, affinity);

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
  viabilityLabel: string,
): string[] {
  const notes: string[] = [];
  const ranked = [...perThreat.values()].sort((a, b) => b.result.score - a.result.score);
  const notable = ranked.filter((v) => v.result.score > 10).slice(0, 2);
  const best = notable.length ? notable : ranked.slice(0, 1);
  for (const { result, weight, threatSpecies } of best) {
    const bits: string[] = [];
    if (result.candidateOhko) bits.push(result.candidateActsFirst ? 'OHKOs' : 'OHKOs, but only if it survives first (slower, no Trick Room)');
    else if (result.candidateGuaranteed2hko) bits.push(result.candidateActsFirst ? 'guaranteed 2HKO' : 'guaranteed 2HKO if it survives first');
    if (result.candidateActsFirst && result.candidateFaster) bits.push(result.candidateNaturallyFaster ? 'naturally outspeeds' : 'outspeeds (needs Scarf)');
    const lead = notable.length ? 'Strong into' : 'Best available matchup:';
    notes.push(`${lead} ${threatSpecies} (${weight.toFixed(0)}% usage)${bits.length ? ' — ' + bits.join(', ') : ''}.`);
  }
  notes.push(viabilityLabel.charAt(0).toUpperCase() + viabilityLabel.slice(1) + '.');
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
  // never gets a chance to "not" pick them, it only fills the remaining
  // slots around them.
  let start: SearchNode = { pickedIdx: [], coverage: new Map(threatIds.map((id) => [id, UNCOVERED_FLOOR])), g: 0 };
  for (const idx of mandatoryIdx) start = applyPick(start, idx, scored, affinity);

  // Simple array-based priority queue (find-max-then-remove): at this
  // problem's scale (a few hundred candidates, a team of 6, budgeted node
  // count) a real binary heap buys nothing observable and this stays easy
  // to follow.
  let frontier: SearchNode[] = [start];
  let best: SearchNode | null = null;
  // The candidate pool can be smaller than TEAM_SIZE (a heavily-restricted
  // tier, or just a thin scouting library) — the search then exhausts its
  // whole frontier down to nothing without ever popping a complete node.
  // Track the best node actually popped along the way so that case still
  // returns whatever real partial team it found, instead of falling through
  // to the frontier array (already empty by then) and landing on the
  // pristine, empty `start` node.
  let bestPartial: SearchNode = start;
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

    if (node.pickedIdx.length > bestPartial.pickedIdx.length || (node.pickedIdx.length === bestPartial.pickedIdx.length && node.g > bestPartial.g)) {
      bestPartial = node;
    }

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
    // No two members carrying the same hazard move — a second Stealth Rock
    // (etc.) setter is a wasted slot, not real redundancy.
    const pickedHazards = new Set(node.pickedIdx.flatMap((i) => hazardMovesOf(scored[i]!.set)));
    const branchCandidates = scored
      .map((c, idx) => ({ idx, c }))
      .filter(
        ({ idx, c }) =>
          !pickedSet.has(idx) &&
          !(c.dexNum !== undefined && pickedDexNums.has(c.dexNum)) &&
          !hazardMovesOf(c.set).some((m) => pickedHazards.has(m)),
      )
      .map(({ idx, c }) => ({
        idx,
        marginal: coverageGain(c, node.coverage) + c.qualityScore + teammateBonus(idx, node.pickedIdx, affinity),
      }))
      .sort((a, b) => b.marginal - a.marginal)
      .slice(0, BRANCH_CAP);

    for (const { idx } of branchCandidates) frontier.push(applyPick(node, idx, scored, affinity));

    // Beam-search prune: keep only the best FRONTIER_CAP nodes by f-score.
    // Every node this drops was already losing the very comparison the next
    // iteration's "find max" scan would have made, so this can only discard
    // nodes the search wouldn't have expanded first anyway.
    if (frontier.length > FRONTIER_CAP) {
      frontier = frontier
        .map((n) => ({ n, f: n.g + heuristic(n, standaloneSorted) }))
        .sort((a, b) => b.f - a.f)
        .slice(0, FRONTIER_CAP)
        .map(({ n }) => n);
    }
  }

  // Budget exhausted, or the frontier fully drained, without a complete
  // node popped — fall back to the best real partial team the search
  // actually found along the way.
  if (!best) best = bestPartial;

  return best.pickedIdx.map((idx) => scored[idx]!);
}

/**
 * Hard-constraint repair pass: the search optimizes for threat coverage and
 * doesn't know about this tier's coverage requirements, so after it returns,
 * swap in a real, legal, Species-Clause-compatible, non-duplicate-hazard
 * replacement for any unmet requirement. The replaced slot is always the
 * current team's weakest, non-mandatory member that isn't itself the ONLY
 * thing satisfying some other still-relevant requirement — so fixing one
 * requirement never silently breaks another.
 */
function enforceRequirements(
  picked: ScoredCandidate[],
  scored: ScoredCandidate[],
  gen: Generation,
  requirements: Requirement[],
  mandatorySpecies: string[],
  affinity: Map<string, number>,
): { team: ScoredCandidate[]; unmet: string[] } {
  const team = [...picked];
  const unmet: string[] = [];

  for (const req of requirements) {
    if (team.some((p) => req.satisfies(gen, p))) continue;

    const pickedIds = new Set(team.map((p) => toID(p.species)));
    const pickedDexNums = new Set(team.map((p) => p.dexNum).filter((n): n is number => n !== undefined));
    const pickedHazards = new Set(team.flatMap((p) => hazardMovesOf(p.set)));
    const replacementOptions = scored
      .filter((c) => !pickedIds.has(toID(c.species)))
      .filter((c) => c.dexNum === undefined || !pickedDexNums.has(c.dexNum))
      .filter((c) => !hazardMovesOf(c.set).some((m) => pickedHazards.has(m)))
      .filter((c) => req.satisfies(gen, c))
      .map((c) => ({
        c,
        value: c.qualityScore + c.weightedSum + team.reduce((s, p) => s + TEAMMATE_WEIGHT * pairAffinity(affinity, c.idx, p.idx), 0),
      }))
      .sort((a, b) => b.value - a.value);

    if (!replacementOptions.length) {
      unmet.push(req.label);
      continue;
    }

    const removable = team
      .map((p, i) => ({ p, i }))
      .filter(({ p }) => !mandatorySpecies.includes(p.species))
      .filter(({ p }) => {
        const otherReqs = requirements.filter((r) => r !== req);
        // Never remove a member if it's the ONLY current pick satisfying
        // some other requirement.
        return !otherReqs.some((r) => r.satisfies(gen, p) && team.filter((q) => q !== p).every((q) => !r.satisfies(gen, q)));
      })
      .sort((a, b) => a.p.qualityScore + a.p.weightedSum - (b.p.qualityScore + b.p.weightedSum))[0];

    if (!removable) {
      unmet.push(req.label);
      continue;
    }

    const replacement = replacementOptions[0]!.c;
    team[removable.i] = {
      ...replacement,
      rationale: [...replacement.rationale, `Added for required ${req.label}.`],
    };
  }

  return { team, unmet };
}
