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
import { toID, speciesMeta, canTerastallize } from '../data/dex.js';
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
  /** Non-fatal notes worth surfacing — e.g. a VR-driven tier's live fetch
   *  failed and this build fell back to the last successfully-fetched copy.
   *  Normally empty. */
  warnings: string[];
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
// A written dex analysis is a curated "here's a good build" from the
// format's own council; a usage-stats spread is just "whatever the highest-
// count real games happened to run," which regularly wins on paper against
// one specific threat list — sometimes by a lot, since a build oriented
// entirely around raw damage into that particular threat list can easily
// out-score a written analysis's more balanced set — without being a build
// anyone should actually be handed. candidate-pool.ts already treats this
// as close to absolute when picking a SINGLE set per species (dex analysis
// always wins if any exists at all, no score comparison); the mandatory
// pick gets the same treatment here rather than a soft margin, since a
// fixed point margin was consistently too small to matter in practice.
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

// A candidate's set is classified physical/special by its own moves' real
// category (not just EV investment) — a set can run a strong physical STAB
// with special-leaning EVs for bulk, and the move category is what actually
// determines whether Will-O-Wisp/burn or a physical wall's Defense stat
// touches it.
function isPhysicalSet(gen: Generation, set: MatchedSet): boolean {
  let physicalCount = 0;
  let specialCount = 0;
  for (const m of set.moves) {
    const move = gen.moves.get(m);
    if (!move) continue;
    if (move.category === 'Physical') physicalCount++;
    else if (move.category === 'Special') specialCount++;
  }
  if (physicalCount !== specialCount) return physicalCount > specialCount;
  return (set.evs.atk ?? 0) >= (set.evs.spa ?? 0); // tie (e.g. all-status, or 2-and-2) — fall back to EV investment
}

// Lum Berry cures/blocks any status on hold; these abilities give an
// outright, permanent status immunity; a Fire Tera specifically blocks
// burn (the status that actually cripples a physical attacker — Toxic just
// costs HP over time rather than gutting the relevant stat).
const STATUS_IMMUNE_ABILITIES = new Set(['waterbubble', 'guts', 'magicbounce', 'comatose', 'purifyingsalt', 'shielddust', 'leafguard']);
function hasStatusImmunity(set: MatchedSet): boolean {
  if (toID(set.item || '') === 'lumberry') return true;
  if (STATUS_IMMUNE_ABILITIES.has(toID(set.ability || ''))) return true;
  if (toID(set.tera || '') === 'fire') return true;
  return false;
}

interface OpponentPattern {
  // Positive favors a physical-leaning candidate, negative favors special —
  // derived from which offensive category the opponent's own team structure
  // seems built to punish or invite.
  physicalLean: number;
  // Weighted prevalence of Will-O-Wisp/Toxic among the threats — a real
  // status-immune answer (Lum Berry, an immunity ability, Tera Fire) is
  // worth more the higher this is.
  statusPressure: number;
}

// Real teambuilding reads the opponent's own move choices, not just their
// species: heavy Will-O-Wisp/Toxic usage cripples a physical attacker
// (burn halves Attack) and rewards anything status-immune; a bulky core
// built specifically around Iron Defense PLUS that status (a physical
// wall) invites special pressure instead, since Iron Defense doesn't touch
// Special Defense. The opposite pattern — Calm Mind + Psyshock (a special
// sweeper that deals physical-formula damage off the target's real
// Defense, telling you the opponent already expects to face weak physical
// bulk) or heavy Blissey usage (the archetypal special wall, physically
// frail) — invites physical pressure instead.
function analyzeOpponentPattern(resolvedThreats: CounterTeamResult['resolvedThreats']): OpponentPattern {
  let physicalWallWeight = 0;
  let specialWallWeight = 0;
  let statusPressure = 0;
  for (const t of resolvedThreats) {
    const moves = t.set.moves.map(toID);
    const hasWisp = moves.includes('willowisp');
    const hasToxic = moves.includes('toxic') || moves.includes('toxicspikes');
    const hasIronDefense = moves.includes('irondefense');
    const hasCalmMind = moves.includes('calmmind');
    const hasPsyshock = moves.includes('psyshock') || moves.includes('psystrike') || moves.includes('secretsword');
    if (hasWisp || hasToxic) statusPressure += t.weight;
    if ((hasWisp || hasToxic) && hasIronDefense) physicalWallWeight += t.weight;
    if ((hasCalmMind && hasPsyshock) || toID(t.species) === 'blissey') specialWallWeight += t.weight;
  }
  return { physicalLean: specialWallWeight - physicalWallWeight, statusPressure };
}

const PHYSICAL_LEAN_SCALE = 0.15; // points per (weight-point of lean) applied to a matching-category candidate
const STATUS_IMMUNITY_BONUS = 12; // flat bonus for a status-immune candidate when statusPressure is real
const STATUS_PRESSURE_THRESHOLD = 20; // minimum weighted status-move prevalence before the immunity bonus kicks in at all

/**
 * Choose a mandatory pick's build from its real, already-scored variants:
 *  1. Restrict to dex-analysis/local-evidence variants FIRST, whenever at
 *     least one exists — a raw usage-stats spread only gets considered at
 *     all when NO written/derived variant exists. This mirrors
 *     candidate-pool.ts's own dex-over-usage priority for a single-set pick
 *     exactly (absolute, not score-based): a written analysis is a curated
 *     build, a usage-stats spread is just "whatever the highest-count real
 *     games happened to run," which can out-score a written analysis
 *     against one specific opponent's threat list without being a build
 *     anyone should actually be handed.
 *  2. Within whichever pool that leaves, prefer the single best-scoring
 *     variant, UNLESS it carries a hazard move and a non-hazard variant
 *     scores within MANDATORY_HAZARD_FLEX_MARGIN of it — a mandatory pick
 *     that's also a real hazard-setter can otherwise "hog" that role and
 *     hazard-dedup-block a genuinely better teammate later (e.g.
 *     Groudon-Primal's Stealth Rock set blocking a Glimmora pick that would
 *     otherwise round out the team); real teambuilding runs the opposite
 *     way, switching the mandatory mon to an attacking set specifically
 *     BECAUSE something else already covers hazards.
 * Exported as its own pure function (only needs `.set`/`.standaloneCeiling`/
 * `.source`, no store/network access) so this decision is unit-testable
 * without pulling in real Smogon variant data.
 */
export function pickBestMandatoryVariant<T extends { set: MatchedSet; standaloneCeiling: number; source: KnownSetSource }>(candidates: T[]): T | null {
  const nonUsage = candidates.filter((c) => c.source !== 'usage');
  const pool = nonUsage.length ? nonUsage : candidates;

  let best: T | null = null;
  let bestNoHazard: T | null = null;
  for (const cand of pool) {
    if (!best || cand.standaloneCeiling > best.standaloneCeiling) best = cand;
    if (!hazardMovesOf(cand.set).length && (!bestNoHazard || cand.standaloneCeiling > bestNoHazard.standaloneCeiling)) bestNoHazard = cand;
  }
  if (best && bestNoHazard && hazardMovesOf(best.set).length && bestNoHazard.standaloneCeiling >= best.standaloneCeiling - MANDATORY_HAZARD_FLEX_MARGIN) {
    best = bestNoHazard;
  }
  return best;
}

interface ScoredCandidate {
  idx: number; // this candidate's own position in the `scored` array — lets later passes (repair) do affinity/coverage lookups without re-searching
  species: string;
  set: MatchedSet;
  source: KnownSetSource;
  viability: number; // raw Smogon usage weight, 0 if untracked (display only)
  isTopTier: boolean; // A- and above on a VR-driven tier's list (see tier-config.ts); always true off a usage-rank tier
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
  if (!resolvedThreats.length) return { threats, resolvedThreats, team: [], unmetRequirements: [], warnings: [] };

  const threatIds = new Set(resolvedThreats.map((t) => toID(t.set.baseSpecies)));
  const historicalWinRates = getHistoricalWinRates(store, formatid, threatIds);
  const genNum = gen.num as GenerationNum;
  const usageRanks = await getUsageRankMap(formatid);
  const opponentPattern = analyzeOpponentPattern(resolvedThreats);

  // A VR-driven tier restricts the ENTIRE candidate pool to that list —
  // fetched fresh every call (see vr-thread.ts, which already retries a
  // transient failure a couple of times, then falls back to the last
  // successfully-fetched copy on disk). Nothing outside it is usable here,
  // no matter how common it is locally or in Smogon's usage stats, so this
  // replaces allCandidateSpecies() entirely rather than adding to it.
  //
  // Three tiers of fallback, in order: (1) the live fetch; (2) the on-disk
  // copy from whatever the last successful live fetch was (handled inside
  // fetchLiveVrMap); (3) a real snapshot bundled with the app itself, for a
  // deployment whose outbound IP Smogon's forum bot-protection blocks
  // outright — that combination means NEITHER (1) nor (2) can ever
  // succeed, since a fetch has to work at least once to populate (2). Only
  // fail outright when even the bundled fallback isn't configured for this
  // tier — that used to surface as every single coverage requirement
  // failing at once ("no legal option was available"), reading like a real
  // teambuilding problem instead of the network/blocking issue it actually
  // is.
  const vrFetch = config.vrThreadUrl ? await fetchLiveVrMap(gen, config.vrThreadUrl, formatid, vrFetchImpl) : { map: null, reason: null, stale: false as const };
  let vrMap = vrFetch.map;
  const warnings: string[] = [];
  if (config.vrThreadUrl && vrMap && vrFetch.stale) {
    warnings.push(
      `Couldn't reach the live Viability Rankings list (${vrFetch.reason}) — using the last successfully-fetched copy` +
        ('savedAt' in vrFetch && vrFetch.savedAt ? ` from ${new Date(vrFetch.savedAt).toLocaleString()}` : '') +
        '. Rankings may be slightly out of date.',
    );
  } else if (config.vrThreadUrl && !vrMap && config.bundledVrFallback) {
    vrMap = config.bundledVrFallback;
    warnings.push(
      `Couldn't reach the live Viability Rankings list (${vrFetch.reason}), and no previously-fetched copy is saved yet — ` +
        'using the version bundled with the app. Rankings may be out of date; this should resolve itself once a live fetch succeeds.',
    );
  } else if (config.vrThreadUrl && !vrMap) {
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
      // Ditto's whole set is Transform — its "own" stats/moves are whatever
      // it copies from its opponent mid-battle, not anything fixed, so a
      // speed/damage comparison against its base kit is meaningless noise
      // rather than a real matchup signal. Still shown in the threat list
      // (real scouting info that Ditto was used), just not scored.
      if (toID(t.species) === 'ditto') continue;
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

    // Reads the opponent's own move choices, not just species — see
    // analyzeOpponentPattern for the reasoning behind each signal.
    const physical = isPhysicalSet(gen, known.set);
    const leanBonus = opponentPattern.physicalLean * (physical ? 1 : -1) * PHYSICAL_LEAN_SCALE;
    const immunityBonus =
      opponentPattern.statusPressure >= STATUS_PRESSURE_THRESHOLD && hasStatusImmunity(known.set) ? STATUS_IMMUNITY_BONUS : 0;

    const qualityScore = viability.score + historyBonus + evidenceBonus + leanBonus + immunityBonus;
    const patternNotes: string[] = [];
    if (leanBonus >= 1) {
      patternNotes.push(
        physical
          ? "Opponent's team leans on special walls (Calm Mind/Psyshock, Blissey) — physical pressure is favored here."
          : "Opponent's team leans on physical walls (status + Iron Defense) — special pressure is favored here.",
      );
    }
    if (immunityBonus > 0) patternNotes.push('Status-immune — safe into the opponent\'s heavy Will-O-Wisp/Toxic usage.');

    return {
      idx: -1, // assigned once pushed into `scored`
      species,
      set: known.set,
      source: known.source,
      viability: usageWeight,
      isTopTier: viability.isTopTier,
      dexNum,
      perThreat,
      weightedSum,
      qualityScore,
      standaloneCeiling: qualityScore + weightedSum,
      rationale: [...buildRationale(perThreat, hr, known.source, viability.label), ...patternNotes],
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
            idx: -1, species, set: known.set, source: known.source, viability: 0, isTopTier: true, dexNum,
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
    // No restriction on recommending a species the opponent also fields —
    // using the same real, strong Pokemon on both sides is completely
    // normal teambuilding, not something to avoid.
    const rawKnown = await getBestKnownSet(store, gen, formatid, species);
    if (!rawKnown) continue;
    const known = await fillRealisticSet(gen, formatid, rawKnown);
    push(await scoreKnownSet(species, known));
  }

  const affinity = await buildAffinityMatrix(formatid, scored);
  const picked = searchTeam(scored, resolvedThreats, affinity, mandatoryIdx);
  const { team: requirementsFixed, unmet } = await enforceRequirements(picked, scored, gen, config.requirements, config.mandatorySpecies, affinity, store, formatid);
  const bulked = await enforceBulkRequirement(requirementsFixed, scored, gen, config.requirements, config.mandatorySpecies, affinity, store, formatid, scoreKnownSet);
  const capped = enforceTopTierCap(bulked, scored, gen, config.requirements, config.mandatorySpecies, affinity);
  const { team: removalFixed, warning: removalWarning } = enforceHazardRemoval(capped, scored, gen, config.requirements, config.mandatorySpecies, affinity);
  if (removalWarning) warnings.push(removalWarning);
  const repaired = await enforceBestVariant(removalFixed, gen, config.requirements, config.mandatorySpecies, store, formatid, scoreKnownSet);

  const team = repaired.map((c) => ({ species: c.species, set: c.set, source: c.source, rationale: c.rationale }));
  return { threats, resolvedThreats, team, unmetRequirements: unmet, warnings };
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

/** Real evidence for whether Tera-ing a pick into `teraType` is a realistic
 *  choice, not just a legal one: (a) does a real, known variant of this SAME
 *  species actually run this Tera in practice — the strongest signal, since
 *  it's direct precedent; (b) does the pick's own moveset already carry a
 *  move of that type, so the Tera would boost an existing STAB-adjacent
 *  attack (Tera-STAB) rather than sitting there for no reason at all.
 *  (A "defensive synergy" signal — does this type remove a real weakness —
 *  was tried and dropped: nearly any single type scores as a numeric
 *  weakness-count improvement over a real dual-type combo, so it couldn't
 *  actually tell a sensible pairing apart from an arbitrary one.)
 *  Higher is more realistic; 0 means no real reason found for this pairing
 *  on this specific Pokemon. */
async function teraFitScore(
  store: Datastore,
  gen: Generation,
  formatid: string,
  species: string,
  set: MatchedSet,
  teraType: string,
): Promise<number> {
  const variants = await getKnownSetVariants(store, gen, formatid, species);
  const hasPrecedent = variants.some((v) => (v.set.tera ?? '').toLowerCase() === teraType.toLowerCase());
  const hasMoveOfType = set.moves.some((m) => toID(gen.moves.get(m)?.type ?? '') === toID(teraType));
  return (hasPrecedent ? 2 : 0) + (hasMoveOfType ? 1 : 0);
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
async function enforceRequirements(
  picked: ScoredCandidate[],
  scored: ScoredCandidate[],
  gen: Generation,
  requirements: Requirement[],
  mandatorySpecies: string[],
  affinity: Map<string, number>,
  store: Datastore,
  formatid: string,
): Promise<{ team: ScoredCandidate[]; unmet: string[] }> {
  const team = [...picked];
  const unmet: string[] = [];

  for (const req of requirements) {
    if (team.some((p) => req.satisfies(gen, p))) continue;

    // Prefer reassigning an existing team member's Tera over swapping in a
    // whole different species — a real top-tier pick's Tera slot is
    // basically free coverage flexibility, whereas bringing in a new
    // species just because it happens to have the right natural typing
    // risks importing a much lower-tier mon for a single requirement. Only
    // applies to type-or-Tera requirements (teraType set) — Steel/Fairy
    // etc. require an actual Pokemon of that type, not a Tera stand-in, so
    // this is skipped entirely for those and falls straight to the
    // species-swap logic below.
    if (req.teraType) {
      const teraType = req.teraType;
      const otherRequirements = requirements.filter((r) => r !== req);
      const eligible = team
        .map((p, i) => ({ p, i }))
        .filter(({ p }) => canTerastallize(gen, p.set.baseSpecies, p.set.item)) // Mega/Primal formes, or a held Z-Crystal, lock out Tera entirely
        .filter(({ p, i }) => {
          const simulated: ScoredCandidate = { ...p, set: { ...p.set, tera: teraType } };
          // Changing p's Tera must not break any OTHER requirement that
          // currently depends on p (its natural type or its current Tera)
          // being the team's only satisfier of that requirement.
          return otherRequirements.every((r) => {
            const satisfiedBefore = team.some((q) => r.satisfies(gen, q));
            if (!satisfiedBefore) return true; // already unmet — this swap can't make it worse
            return team.some((q, j) => (j === i ? r.satisfies(gen, simulated) : r.satisfies(gen, q)));
          });
        });

      const scoredEligible = await Promise.all(
        eligible.map(async ({ p, i }) => ({ p, i, fit: await teraFitScore(store, gen, formatid, p.species, p.set, teraType) })),
      );
      const reassignable = scoredEligible.sort((a, b) => {
        // Real precedent/offensive synergy first — an "idle Tera slot" that
        // makes no sense for the species (Calyrex-Ice into Poison, say)
        // isn't actually a good answer just because it's technically free.
        if (a.fit !== b.fit) return b.fit - a.fit;
        // Then prefer a member whose Tera isn't already doing anything
        // (free to reassign) over one that would be giving something up.
        const idle = (p: ScoredCandidate) => (!p.set.tera || p.set.tera.toLowerCase() === 'nothing' ? 0 : 1);
        return idle(a.p) - idle(b.p) || b.p.qualityScore - a.p.qualityScore;
      })[0];

      // A fit of 0 means NO current team member has any real precedent or
      // offensive synergy for this Tera type — forcing it onto whichever one
      // happens to have an idle slot would just be a different flavor of the
      // same arbitrary pairing this whole scoring pass exists to avoid (e.g.
      // Calyrex-Ice into Tera Poison). Only reassign when the best option is
      // an actually-fitting one; otherwise fall through to bringing in a real
      // species that naturally has this typing/precedent.
      if (reassignable && reassignable.fit > 0) {
        team[reassignable.i] = {
          ...reassignable.p,
          set: { ...reassignable.p.set, tera: teraType },
          rationale: [...reassignable.p.rationale, `Tera changed to ${teraType} to satisfy required ${req.label}.`],
        };
        continue;
      }
    }

    // Which slot to free up — decided BEFORE the replacement candidate
    // pool, so that pool's own dex-number exclusion can leave that one
    // slot's dex number open (a same-family swap, e.g. Arceus-Ghost being
    // replaced by Arceus-Dark, must stay legal even though they share one).
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

    const others = team.filter((_, j) => j !== removable.i);
    const pickedIds = new Set(others.map((p) => toID(p.species)));
    const pickedDexNums = new Set(others.map((p) => p.dexNum).filter((n): n is number => n !== undefined));
    const pickedHazards = new Set(others.flatMap((p) => hazardMovesOf(p.set)));
    const replacementOptions = scored
      .filter((c) => !pickedIds.has(toID(c.species)))
      .filter((c) => c.dexNum === undefined || !pickedDexNums.has(c.dexNum))
      .filter((c) => !hazardMovesOf(c.set).some((m) => pickedHazards.has(m)))
      .filter((c) => req.satisfies(gen, c))
      .map((c) => ({
        c,
        value: c.qualityScore + c.weightedSum + others.reduce((s, p) => s + TEAMMATE_WEIGHT * pairAffinity(affinity, c.idx, p.idx), 0),
      }))
      .sort((a, b) => b.value - a.value);

    if (!replacementOptions.length) {
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

// Beyond the mandatory pick itself, at most this many non-mandatory picks
// may fall below top tier (A- and up on a VR-driven tier) — a hard cap, not
// just a scoring lean, so a narrow structural requirement (a natural-only
// type with thin top-tier options) can still use its one exception without
// the rest of the team drifting down with it.
const MAX_LOW_TIER_PICKS = 1;

/**
 * Runs after enforceRequirements, once every coverage requirement is
 * already satisfied: if more than MAX_LOW_TIER_PICKS non-mandatory members
 * are below top tier, try upgrading all but the single best of them to a
 * real, unpicked top-tier candidate — reusing the same
 * "don't break a requirement this member was the only satisfier of" check
 * enforceRequirements already uses, so an upgrade can never undo a fix that
 * pass just made. A member with no viable top-tier replacement (nothing
 * else covers what it does) is left in place — the cap is a target, not a
 * guarantee when the real candidate pool can't support it.
 */
function enforceTopTierCap(
  team: ScoredCandidate[],
  scored: ScoredCandidate[],
  gen: Generation,
  requirements: Requirement[],
  mandatorySpecies: string[],
  affinity: Map<string, number>,
): ScoredCandidate[] {
  const result = [...team];
  const isCappable = (p: ScoredCandidate) => !p.isTopTier && !mandatorySpecies.includes(p.species);
  const lowTier = result.map((p, i) => ({ p, i })).filter(({ p }) => isCappable(p));
  if (lowTier.length <= MAX_LOW_TIER_PICKS) return result;

  // Keep the single best (by its own quality + matchup) low-tier member as
  // the allowed exception; try to upgrade the rest.
  lowTier.sort((a, b) => b.p.qualityScore + b.p.weightedSum - (a.p.qualityScore + a.p.weightedSum));
  const toUpgrade = lowTier.slice(MAX_LOW_TIER_PICKS);

  for (const { i } of toUpgrade) {
    // Exclude slot i's OWN species/dex-number/hazards from the "already
    // taken" blocklist — we're replacing that exact slot, not adding a 7th
    // member, so a same-family upgrade (Arceus-Ghost -> Arceus-Dark) must
    // stay legal even though they share a dex number.
    const others = result.filter((_, j) => j !== i);
    const pickedIds = new Set(others.map((q) => toID(q.species)));
    const pickedDexNums = new Set(others.map((q) => q.dexNum).filter((n): n is number => n !== undefined));
    const pickedHazards = new Set(others.flatMap((q) => hazardMovesOf(q.set)));
    const candidates = scored
      .filter((c) => c.isTopTier)
      .filter((c) => !pickedIds.has(toID(c.species)))
      .filter((c) => c.dexNum === undefined || !pickedDexNums.has(c.dexNum))
      .filter((c) => !hazardMovesOf(c.set).some((m) => pickedHazards.has(m)))
      .filter((c) =>
        requirements.every((r) => {
          const satisfiedBefore = result.some((q) => r.satisfies(gen, q));
          if (!satisfiedBefore) return true;
          return result.some((q, j) => (j === i ? r.satisfies(gen, c) : r.satisfies(gen, q)));
        }),
      )
      .map((c) => ({
        c,
        value: c.qualityScore + c.weightedSum + result.reduce((s, q, j) => (j === i ? s : s + TEAMMATE_WEIGHT * pairAffinity(affinity, c.idx, q.idx)), 0),
      }))
      .sort((a, b) => b.value - a.value);

    if (candidates.length) {
      const upgrade = candidates[0]!.c;
      result[i] = { ...upgrade, rationale: [...upgrade.rationale, 'Swapped in to keep the team weighted toward top-tier picks.'] };
    }
  }

  return result;
}

// A real defensive EV spread (HP + a defensive stat) totaling at least
// this much — high enough that a genuine wall/pivot clears it (a classic
// 252 HP/252 Def spread is 504), but a bulky-offense hybrid with real
// investment in one defensive stat can too. A Choice item/max-offense
// glass cannon (e.g. 248 HP/248 Atk/12 Def) falls well short.
const BULKY_EV_THRESHOLD = 320;
// A team that's ALL sharp offensive threats can't actually switch into a
// real, dangerous setup sweeper (a Dragon Dance Necrozma-Dusk-Mane, an
// Ultra Necrozma) — it just gets run over, since scoreMatchup's own
// per-threat scoring rewards winning a damage race, not surviving to take
// the hit at all. This is a team-structure requirement, the same way speed
// control or a type requirement is — at least this many non-mandatory picks
// need a real defensive backbone, not just raw power.
const MIN_BULKY_PICKS = 2;

function bulkScore(set: MatchedSet): number {
  return (set.evs.hp ?? 0) + (set.evs.def ?? 0) + (set.evs.spd ?? 0);
}
function isBulky(set: MatchedSet): boolean {
  return bulkScore(set) >= BULKY_EV_THRESHOLD;
}

/** A Focus Sash hazard-setting lead (sash Glimmora, Deoxys-Speed, Smeargle,
 *  ...) signals a hyper-offense team archetype on its own — the lead sets
 *  hazards once and is expected to die, and the other 5 slots are meant to
 *  be setup sweepers/breakers, not defensive picks. The bulk requirement
 *  below doesn't apply to that structure at all. */
function isHazardLead(set: MatchedSet): boolean {
  return toID(set.item || '') === 'focussash' && hazardMovesOf(set).length > 0;
}

/**
 * Runs after enforceRequirements: if fewer than MIN_BULKY_PICKS
 * non-mandatory members carry real defensive investment, upgrade the
 * least-bulky of them (worst first). For each, tries a bulkier REAL variant
 * of the SAME species first (Smogon's own dex analysis very often has a
 * distinct "Defensive" role alongside the offensive one already picked —
 * keeping the species is strictly better than swapping it out, since it
 * doesn't disturb whatever else the search already liked about that slot),
 * then falls back to swapping in a different bulky species from `scored` —
 * preferring a top-tier one so this doesn't just get undone by
 * enforceTopTierCap right after — using the same "don't break a requirement
 * this member was the only satisfier of" check the other repair passes use.
 * Skipped entirely for a team already built around a sash hazard lead (see
 * isHazardLead).
 */
async function enforceBulkRequirement(
  team: ScoredCandidate[],
  scored: ScoredCandidate[],
  gen: Generation,
  requirements: Requirement[],
  mandatorySpecies: string[],
  affinity: Map<string, number>,
  store: Datastore,
  formatid: string,
  scoreKnownSet: (species: string, known: KnownSet) => Promise<ScoredCandidate | null>,
): Promise<ScoredCandidate[]> {
  const result = [...team];
  if (result.some((p) => isHazardLead(p.set))) return result;
  const nonMandatory = result.map((p, i) => ({ p, i })).filter(({ p }) => !mandatorySpecies.includes(p.species));
  const bulkyCount = nonMandatory.filter(({ p }) => isBulky(p.set)).length;
  const needed = MIN_BULKY_PICKS - bulkyCount;
  if (needed <= 0) return result;

  const toUpgrade = nonMandatory
    .filter(({ p }) => !isBulky(p.set))
    .sort((a, b) => bulkScore(a.p.set) - bulkScore(b.p.set)) // least bulky first
    .slice(0, needed);

  for (const { i } of toUpgrade) {
    const current = result[i]!;

    // First choice: a bulkier real variant of this SAME species, if one
    // exists — doesn't cost the slot's Species-Clause/hazard/requirement
    // contribution at all, just swaps the build.
    const variants = await getKnownSetVariants(store, gen, formatid, current.species);
    let bulkyRescored: ScoredCandidate | null = null;
    for (const rawKnown of variants) {
      if (!isBulky(rawKnown.set)) continue;
      const filled = await fillRealisticSet(gen, formatid, rawKnown);
      if (!isBulky(filled.set)) continue; // padding shouldn't change this, but stay honest if it somehow did
      const rescored = await scoreKnownSet(current.species, filled);
      if (rescored && (!bulkyRescored || rescored.standaloneCeiling > bulkyRescored.standaloneCeiling)) bulkyRescored = rescored;
    }
    if (bulkyRescored) {
      result[i] = {
        ...bulkyRescored,
        rationale: [...bulkyRescored.rationale, 'Switched to a bulkier real set — the team needs a genuine pivot into setup sweepers, not just offense.'],
      };
      continue;
    }

    // Exclude slot i's OWN species/dex-number/hazards — we're replacing
    // that exact slot, so a same-family upgrade must stay legal even
    // though it shares a dex number with what's currently there.
    const others = result.filter((_, j) => j !== i);
    const pickedIds = new Set(others.map((q) => toID(q.species)));
    const pickedDexNums = new Set(others.map((q) => q.dexNum).filter((n): n is number => n !== undefined));
    const pickedHazards = new Set(others.flatMap((q) => hazardMovesOf(q.set)));
    const candidates = scored
      .filter((c) => isBulky(c.set))
      .filter((c) => !pickedIds.has(toID(c.species)))
      .filter((c) => c.dexNum === undefined || !pickedDexNums.has(c.dexNum))
      .filter((c) => !hazardMovesOf(c.set).some((m) => pickedHazards.has(m)))
      .filter((c) =>
        requirements.every((r) => {
          const satisfiedBefore = result.some((q) => r.satisfies(gen, q));
          if (!satisfiedBefore) return true;
          return result.some((q, j) => (j === i ? r.satisfies(gen, c) : r.satisfies(gen, q)));
        }),
      )
      .map((c) => ({
        c,
        value: c.qualityScore + c.weightedSum + result.reduce((s, q, j) => (j === i ? s : s + TEAMMATE_WEIGHT * pairAffinity(affinity, c.idx, q.idx)), 0),
      }))
      .sort((a, b) => (Number(b.c.isTopTier) - Number(a.c.isTopTier)) || b.value - a.value); // prefer a top-tier bulky option first

    if (candidates.length) {
      const upgrade = candidates[0]!.c;
      result[i] = {
        ...upgrade,
        rationale: [...upgrade.rationale, 'Added for real defensive investment — the team needs a genuine pivot into setup sweepers, not just offense.'],
      };
    }
  }

  return result;
}

const REMOVAL_MOVES = new Set(['defog', 'rapidspin', 'mortalspin', 'courtchange', 'tidyup']);
function hasRemovalMove(set: MatchedSet): boolean {
  return set.moves.map(toID).some((m) => REMOVAL_MOVES.has(m));
}

/**
 * If nothing on the team can clear entry hazards, the whole team eats
 * repeated Stealth Rock/Spikes chip on every switch-in. Fix, in order:
 * (1) swap in a real Defog/Rapid Spin user already among the scored
 * candidates for team-wide removal, if one exists without breaking a
 * currently-met requirement; (2) otherwise, give Heavy-Duty Boots to every
 * pick that isn't locked into a different item by its own forme (a Mega
 * Stone, Rusted Sword, an Orb) and where doing so doesn't strip away a
 * requirement's only satisfier (a team's sole Choice Scarf holding up the
 * speed-control requirement, for instance).
 */
function enforceHazardRemoval(
  team: ScoredCandidate[],
  scored: ScoredCandidate[],
  gen: Generation,
  requirements: Requirement[],
  mandatorySpecies: string[],
  affinity: Map<string, number>,
): { team: ScoredCandidate[]; warning?: string } {
  if (team.some((p) => hasRemovalMove(p.set))) return { team };

  // Which slot to free up — decided BEFORE the replacement candidate pool,
  // so that pool's own dex-number exclusion can leave that one slot's dex
  // number open (a same-family swap must stay legal even though it shares
  // one).
  const removable = team
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => !mandatorySpecies.includes(p.species))
    .filter(({ p }) => !requirements.some((r) => r.satisfies(gen, p) && team.filter((q) => q !== p).every((q) => !r.satisfies(gen, q))))
    .sort(
      (a, b) =>
        a.p.qualityScore + a.p.weightedSum + team.reduce((s, q) => (q === a.p ? s : s + TEAMMATE_WEIGHT * pairAffinity(affinity, a.p.idx, q.idx)), 0) -
        (b.p.qualityScore + b.p.weightedSum + team.reduce((s, q) => (q === b.p ? s : s + TEAMMATE_WEIGHT * pairAffinity(affinity, b.p.idx, q.idx)), 0)),
    )[0];

  if (removable) {
    const others = team.filter((_, j) => j !== removable.i);
    const pickedIds = new Set(others.map((p) => toID(p.species)));
    const pickedDexNums = new Set(others.map((p) => p.dexNum).filter((n): n is number => n !== undefined));
    const pickedHazards = new Set(others.flatMap((p) => hazardMovesOf(p.set)));
    const defoggers = scored
      .filter((c) => hasRemovalMove(c.set))
      .filter((c) => !pickedIds.has(toID(c.species)))
      .filter((c) => c.dexNum === undefined || !pickedDexNums.has(c.dexNum))
      .filter((c) => !hazardMovesOf(c.set).some((m) => pickedHazards.has(m)))
      .sort((a, b) => (Number(b.isTopTier) - Number(a.isTopTier)) || b.qualityScore + b.weightedSum - (a.qualityScore + a.weightedSum));

    if (defoggers.length) {
      const next = [...team];
      const pick = defoggers[0]!;
      next[removable.i] = { ...pick, rationale: [...pick.rationale, 'Added for hazard removal — nothing else on the team could clear Stealth Rock/Spikes.'] };
      return { team: next };
    }
  }

  // No viable Defog/Spin swap-in — fall back to Heavy-Duty Boots on every
  // eligible pick instead.
  let bootedAny = false;
  const next = team.map((p, i) => {
    const forcedItem = speciesMeta(gen, p.set.baseSpecies)?.requiredItem;
    if (forcedItem) return p; // Rusted Sword / Red Orb / Blue Orb / a Mega Stone — can't be swapped off
    if (toID(p.set.item || '') === 'heavydutyboots') return p;
    const simulated: ScoredCandidate = { ...p, set: { ...p.set, item: 'Heavy-Duty Boots' } };
    const breaksRequirement = requirements.some((r) => {
      const satisfiedBefore = team.some((q) => r.satisfies(gen, q));
      if (!satisfiedBefore) return false;
      return !team.some((q, j) => (j === i ? r.satisfies(gen, simulated) : r.satisfies(gen, q)));
    });
    if (breaksRequirement) return p; // e.g. this pick's Choice Scarf is the team's only speed control
    bootedAny = true;
    return { ...p, set: { ...p.set, item: 'Heavy-Duty Boots' }, rationale: [...p.rationale, 'Given Heavy-Duty Boots — no hazard removal on the team, so every eligible pick needs to be self-sufficient against Stealth Rock/Spikes.'] };
  });
  return {
    team: next,
    warning: bootedAny ? 'No hazard removal was available for this team — every eligible pick was given Heavy-Duty Boots instead.' : undefined,
  };
}

/**
 * Final polish: every non-mandatory pick's build only ever came from
 * getBestKnownSet's SINGLE best-known set for that species — good most of
 * the time, but not the same rigor the mandatory pick gets (which evaluates
 * every real variant and picks whichever actually answers this matchup
 * best). This does the same for the rest of the team: re-score every real
 * variant of each already-picked species, and switch to a genuinely
 * better-scoring one if it exists — reusing pickBestMandatoryVariant's own
 * dex-over-usage-stats and hazard-flex preferences, so a build like a real
 * Boots/Tera-Fire/Swords-Dance role can win out over whatever the first-
 * listed dex-analysis role happened to be (a raw Choice Band set, say) when
 * it's genuinely the stronger real answer here.
 */
async function enforceBestVariant(
  team: ScoredCandidate[],
  gen: Generation,
  requirements: Requirement[],
  mandatorySpecies: string[],
  store: Datastore,
  formatid: string,
  scoreKnownSet: (species: string, known: KnownSet) => Promise<ScoredCandidate | null>,
): Promise<ScoredCandidate[]> {
  const result = [...team];
  for (let i = 0; i < result.length; i++) {
    const current = result[i]!;
    if (mandatorySpecies.includes(current.species)) continue;

    const variants = await getKnownSetVariants(store, gen, formatid, current.species);
    const rescored: ScoredCandidate[] = [];
    for (const rawKnown of variants) {
      const filled = await fillRealisticSet(gen, formatid, rawKnown);
      const cand = await scoreKnownSet(current.species, filled);
      if (cand) rescored.push(cand);
    }
    if (!rescored.length) continue;

    const best = pickBestMandatoryVariant(rescored);
    if (!best || best.standaloneCeiling <= current.standaloneCeiling) continue;

    const simulated: ScoredCandidate = { ...current, set: best.set, source: best.source, standaloneCeiling: best.standaloneCeiling };
    const breaksRequirement = requirements.some((r) => {
      const satisfiedBefore = result.some((q) => r.satisfies(gen, q));
      if (!satisfiedBefore) return false;
      return !result.some((q, j) => (j === i ? r.satisfies(gen, simulated) : r.satisfies(gen, q)));
    });
    if (breaksRequirement) continue;

    result[i] = { ...best, idx: current.idx, rationale: [...best.rationale, 'Switched to a better-evidenced real build for this matchup.'] };
  }
  return result;
}
