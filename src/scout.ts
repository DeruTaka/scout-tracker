// End-to-end pipeline: replay -> parsed reveals -> candidate sets (dex +
// historical priors) -> damage-based set selection -> EV derivation -> legality
// -> importable pastes.
import type { DexSet, MatchedSet, Replay, ScoutedReplay, ScoutedTeam } from './types.js';
import { getGen, toID } from './data/dex.js';
import { getSetsForSpecies } from './data/sets-provider.js';
import { parseReplay } from './replay/parse.js';
import { candidateMatchedSets } from './match/match-set.js';
import { extractObservations } from './ev/field-tracker.js';
import { extractSpeedObservations } from './ev/speed-tracker.js';
import { deriveEvs, deriveSpeed, pickReferenceEvs, selectSetsByDamage, type SideCandidates } from './ev/engine.js';
import { exportTeam } from './build/team-paste.js';
import { illegalFilledMoves } from './build/pokemon-set.js';
import { getUsageSets, getUsageSummary } from './data/usage-provider.js';

export interface ScoutOptions {
  /**
   * Supply extra candidate sets (a trainer's historical sets and/or common
   * usage) for a given player + format + species. These join the dex sets in
   * the pool that damage evidence selects among.
   */
  getPriorSets?: (player: string, formatid: string, baseSpecies: string) => DexSet[] | Promise<DexSet[]>;
  /** Pull Smogon usage stats as extra candidates + a reference note (default on). */
  useUsage?: boolean;
}

function setSignature(s: DexSet): string {
  const moves = [...s.movepool].map(toID).sort().join(',');
  const item = Array.isArray(s.item) ? s.item.join('/') : s.item ?? '';
  const nature = Array.isArray(s.nature) ? s.nature.join('/') : s.nature ?? '';
  return `${moves}|${item}|${nature}|${JSON.stringify(s.evs ?? {})}`;
}

function mergeSets(...lists: DexSet[][]): DexSet[] {
  const out: DexSet[] = [];
  const seen = new Set<string>();
  for (const s of lists.flat()) {
    const sig = setSignature(s);
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push(s);
  }
  return out;
}

export async function scoutReplay(replay: Replay, opts: ScoutOptions = {}): Promise<ScoutedReplay> {
  const gen = getGen(replay.gen);
  const useUsage = opts.useUsage !== false;
  const teams = parseReplay(replay);
  const observations = extractObservations(replay);

  // Build candidate pools per mon (dex sets + historical priors + usage stats).
  // Cache each mon's own priors (trainer history + common usage, already
  // fetched here) keyed by side+species, so Pass C below can consult "how does
  // this trainer usually build this Pokemon" without a second, async lookup.
  const priorsBySideSpecies = new Map<string, DexSet[]>();
  const sideCands: SideCandidates[] = [];
  for (const team of teams) {
    const candidates: MatchedSet[][] = [];
    for (const mon of team.mons) {
      const dexSets = await getSetsForSpecies(replay.formatid, mon.baseSpecies);
      const priors = opts.getPriorSets
        ? await opts.getPriorSets(team.player, replay.formatid, mon.baseSpecies)
        : [];
      priorsBySideSpecies.set(`${team.side}:${toID(mon.baseSpecies)}`, priors);
      const usage = useUsage ? await getUsageSets(gen, replay.formatid, mon.baseSpecies) : [];
      candidates.push(candidateMatchedSets(gen, mon, mergeSets(priors, dexSets, usage)));
    }
    sideCands.push({ side: team.side, candidates });
  }

  // Let observed damage pick the best-fitting set, derive Speed from turn order
  // FIRST (its speedFloor gates how far the bulk trade below may sacrifice it),
  // then fine-tune the rest of the spread.
  const sideSets = selectSetsByDamage(replay.gen, sideCands, observations);
  deriveSpeed(replay.gen, sideSets, extractSpeedObservations(replay));
  deriveEvs(replay.gen, sideSets, observations, {
    referenceEvs: (side, baseSpecies) => pickReferenceEvs(priorsBySideSpecies.get(`${side}:${toID(baseSpecies)}`) ?? []),
  });

  // Legality pass (flags dex-filled moves that aren't learnable; revealed moves
  // are trusted). Then export pastes.
  const scoutedTeams: ScoutedTeam[] = [];
  for (let i = 0; i < teams.length; i++) {
    const sets = sideSets[i]!.sets;
    for (const ms of sets) {
      if (ms.unrevealed) continue; // nothing revealed → attach no guessed data
      const bad = await illegalFilledMoves(gen, ms);
      if (bad.length) ms.notes.push(`Possibly illegal filled move(s): ${bad.join(', ')}.`);
      if (useUsage) {
        const summary = await getUsageSummary(gen, replay.formatid, ms.baseSpecies);
        if (summary) ms.notes.push(summary);
      }
    }
    scoutedTeams.push({
      player: teams[i]!.player,
      side: teams[i]!.side,
      sets,
      paste: exportTeam(sets),
    });
  }

  return { replay, teams: scoutedTeams, scoutedAt: Date.now() };
}
