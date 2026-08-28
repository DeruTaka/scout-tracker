// Orchestrates the counter-team builder: resolve real sets for the opponent's
// threats, score every real candidate species against them, blend in
// historical win-rate and evidence-quality signals, then assemble 6 picks via
// greedy weighted max-coverage (each pick maximizes the team's improvement in
// aggregate weighted coverage against the threat list — a lightweight stand-in
// for full synergy analysis, not an exhaustive combinatorial search).
import type { Generation, GenerationNum } from '@pkmn/data';
import type { Datastore } from '../store/datastore.js';
import type { MatchedSet } from '../types.js';
import { toID } from '../data/dex.js';
import type { ThreatProfile } from './threat-profile.js';
import { getBestKnownSet, allCandidateSpecies, type KnownSetSource } from './candidate-pool.js';
import { scoreMatchup, type MatchupResult } from './score.js';
import { getHistoricalWinRates } from './historical.js';

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
const UNCOVERED_FLOOR = -100; // sentinel "this threat is entirely unaddressed" coverage level

function sampleConfidence(n: number): number {
  return Math.min(n / 5, 1);
}

interface ScoredCandidate {
  species: string;
  set: MatchedSet;
  source: KnownSetSource;
  perThreat: Map<string, { result: MatchupResult; weight: number; threatSpecies: string }>;
  totalScore: number;
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

    scored.push({
      species,
      set: known.set,
      source: known.source,
      perThreat,
      totalScore: weightedSum + historyBonus + evidenceBonus,
      rationale: buildRationale(perThreat, hr, known.source),
    });
  }

  const team = pickTeam(scored, resolvedThreats);
  return { threats, resolvedThreats, team };
}

function buildRationale(
  perThreat: Map<string, { result: MatchupResult; weight: number; threatSpecies: string }>,
  hr: { wins: number; total: number } | undefined,
  source: KnownSetSource,
): string[] {
  const notes: string[] = [];
  const ranked = [...perThreat.values()].sort((a, b) => b.result.score - a.result.score);
  // Notable (score > 10) matchups get called out specifically; if this pick
  // was chosen purely for its incremental team-coverage value and clears
  // that bar against nothing individually, fall back to its single best
  // matchup so the rationale is never empty.
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
  if (hr && hr.total >= 2) {
    notes.push(`Historically ${hr.wins}-${hr.total - hr.wins} in scouted games vs. cores with 2+ of these threats.`);
  }
  if (source !== 'store') {
    notes.push(`No local scouting data for this species — using ${source === 'usage' ? 'Smogon usage stats' : "Smogon's dex analysis"} instead.`);
  }
  return notes;
}

function pickTeam(scored: ScoredCandidate[], resolvedThreats: CounterTeamResult['resolvedThreats']): TeamPick[] {
  const coverage = new Map<string, number>();
  for (const t of resolvedThreats) coverage.set(toID(t.set.baseSpecies), UNCOVERED_FLOOR);

  const picked: ScoredCandidate[] = [];
  const remaining = new Set(scored.map((_, i) => i));

  for (let slot = 0; slot < TEAM_SIZE && remaining.size; slot++) {
    let bestIdx = -1;
    let bestValue = -Infinity;
    for (const i of remaining) {
      const cand = scored[i]!;
      let coverageGain = 0;
      for (const [id, { result, weight }] of cand.perThreat) {
        const cur = coverage.get(id)!;
        coverageGain += weight * (Math.max(cur, result.score) - cur);
      }
      // The first pick has no existing coverage to improve on, so fall back
      // to its own total score; later picks are judged purely on marginal
      // improvement (plus a tiny nudge from totalScore to break ties sanely).
      const value = picked.length === 0 ? cand.totalScore : coverageGain + cand.totalScore * 0.01;
      if (value > bestValue) {
        bestValue = value;
        bestIdx = i;
      }
    }
    if (bestIdx === -1) break;
    const chosen = scored[bestIdx]!;
    picked.push(chosen);
    remaining.delete(bestIdx);
    for (const [id, { result }] of chosen.perThreat) {
      coverage.set(id, Math.max(coverage.get(id)!, result.score));
    }
  }

  return picked.map((p) => ({ species: p.species, set: p.set, source: p.source, rationale: p.rationale }));
}
