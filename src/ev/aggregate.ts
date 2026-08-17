// Cross-replay EV/item aggregation. A single replay often gives a mon only 1-2
// damage hits — too little signal for deriveEvs to confidently move off the
// dex/usage prior, so it "gives up" with a low-confidence, unrefined spread.
// When a trainer has piloted the EXACT SAME 6-Pokemon roster across several
// stored replays, this pools every usable damage observation for a species
// across all of them and re-derives ONE shared spread from the combined
// evidence — then writes it back onto every member replay.
//
// Move selection is intentionally left untouched: a build's revealed moves can
// legitimately vary run to run, so only EVs / nature / an inferred item are
// pooled.
import type { Datastore, StoredReplay } from '../store/datastore.js';
import type { DamageObservation, MatchedSet, Replay } from '../types.js';
import { toID } from '../data/dex.js';
import { extractObservations } from './field-tracker.js';
import { deriveEvs, type SideSets } from './engine.js';
import { exportTeam } from '../build/team-paste.js';

/** Exact-roster identity: the sorted set of base species across the team. */
export function teamFingerprint(sets: MatchedSet[]): string {
  return [...new Set(sets.map((s) => toID(s.baseSpecies)))].sort().join('|');
}

interface GroupMember {
  replay: StoredReplay;
  gen: number;
  sideInReplay: 'p1' | 'p2';
  sets: MatchedSet[]; // this trainer's OWN sets for this replay (live reference)
  opponentSets: MatchedSet[]; // the other team's sets, for this replay only
}

/** Every stored replay where `playerId` piloted the exact roster `fingerprint`. */
function findGroup(store: Datastore, playerId: string, formatid: string, fingerprint: string): GroupMember[] {
  const out: GroupMember[] = [];
  for (const r of store.replays) {
    if (r.formatid !== formatid || !r.log) continue;
    for (const t of r.teams) {
      if (toID(t.player) !== playerId) continue;
      if (teamFingerprint(t.sets) !== fingerprint) continue;
      const opp = r.teams.find((o) => o.side !== t.side);
      out.push({ replay: r, gen: r.gen, sideInReplay: t.side, sets: t.sets, opponentSets: opp?.sets ?? [] });
    }
  }
  return out;
}

/** Prefer a replay where the item was directly revealed (ground truth); else
 *  whichever read is currently most confident. */
function betterSeed(a: MatchedSet, b: MatchedSet): boolean {
  if (a.itemRevealed !== b.itemRevealed) return a.itemRevealed;
  return a.confidence >= b.confidence;
}

const POOL_NOTE_HEADER = 'Pooled across';
const POOL_NOTE_CHILD = '  ↳ ';

/**
 * Re-derive EVs/nature/(inferred) item for `playerId`'s `fingerprint` team by
 * pooling usable damage observations across every stored replay of it, then
 * write the result back onto every member replay's stored sets + paste.
 * Safe to call repeatedly (e.g. after every new ingest of the same team) —
 * always works from a fresh scratch derivation, never accumulates state.
 */
export function aggregateGroup(
  store: Datastore,
  playerId: string,
  formatid: string,
  fingerprint: string,
): { replaysUpdated: number; speciesCount: number } {
  const members = findGroup(store, playerId, formatid, fingerprint);
  if (members.length < 2) return { replaysUpdated: 0, speciesCount: 0 }; // nothing to pool yet
  const gen = members[0]!.gen;
  if (gen <= 2) return { replaysUpdated: 0, speciesCount: 0 }; // no EV calc for RBY/GSC

  const seedBySpecies = new Map<string, MatchedSet>();
  for (const m of members) {
    for (const ms of m.sets) {
      if (ms.unrevealed) continue;
      const cur = seedBySpecies.get(ms.baseSpecies);
      if (!cur || betterSeed(ms, cur)) seedBySpecies.set(ms.baseSpecies, ms);
    }
  }
  if (seedBySpecies.size === 0) return { replaysUpdated: 0, speciesCount: 0 };

  // Fresh scratch clones — deriveEvs mutates these, never the live stored sets
  // directly, so re-running aggregation as more replays arrive never piles up
  // duplicate notes on a long-lived object.
  const working = new Map<string, MatchedSet>();
  for (const [species, seed] of seedBySpecies) working.set(species, { ...seed, evs: { ...seed.evs }, notes: [] });

  // Synthetic multi-replay "team": the trainer's own mons share ONE canonical
  // set (label "AGG"); each replay keeps its OWN opponent under a per-replay
  // label so two different replays' opponents never collide under one key.
  // (SideSets/DamageObservation side types are 'p1'|'p2' by contract; these
  // labels are only ever used as opaque map keys inside the engine, so the
  // casts below are safe.)
  const AGG = 'p1' as const;
  const teams: SideSets[] = [{ side: AGG, sets: [...working.values()] }];
  const observations: DamageObservation[] = [];
  members.forEach((m, i) => {
    const oppLabel = `R${i}` as unknown as 'p2';
    teams.push({ side: oppLabel, sets: m.opponentSets });
    const raw = { gen: m.gen, log: m.replay.log } as Replay;
    for (const o of extractObservations(raw)) {
      if (!o.usable) continue;
      observations.push({
        ...o,
        attackerSide: (o.attackerSide === m.sideInReplay ? AGG : oppLabel) as any,
        defenderSide: (o.defenderSide === m.sideInReplay ? AGG : oppLabel) as any,
      });
    }
  });

  deriveEvs(gen, teams, observations);

  for (const m of members) {
    for (const ms of m.sets) {
      if (ms.unrevealed) continue;
      const result = working.get(ms.baseSpecies);
      if (!result) continue;
      ms.evs = { ...result.evs };
      ms.nature = result.nature;
      ms.evSource = result.evSource;
      ms.confidence = result.confidence;
      // A directly-revealed item is ground truth for THIS replay — never let
      // the pooled read override it, even if other replays disagree.
      if (!ms.itemRevealed) {
        ms.item = result.item;
        ms.itemRevealed = result.itemRevealed;
      }
      ms.notes = ms.notes.filter((n) => !n.startsWith(POOL_NOTE_HEADER) && !n.startsWith(POOL_NOTE_CHILD));
      ms.notes.push(`${POOL_NOTE_HEADER} ${members.length} replays of this same team:`);
      for (const n of result.notes) ms.notes.push(POOL_NOTE_CHILD + n);
    }
    m.replay.teams.find((t) => t.sets === m.sets)!.paste = exportTeam(m.sets);
  }

  return { replaysUpdated: members.length, speciesCount: seedBySpecies.size };
}

/**
 * Run aggregation for every (trainer, team) group a just-scouted replay
 * belongs to. Call after storing the replay; call store.rebuildUniqueSets()
 * afterward since sets may have changed.
 */
export function aggregateAffectedGroups(
  store: Datastore,
  scoutedFormatid: string,
  scoutedPlayers: string[],
): { groups: number; replaysUpdated: number } {
  const seen = new Set<string>();
  let groups = 0;
  let replaysUpdated = 0;
  for (const player of scoutedPlayers) {
    const playerId = toID(player);
    // Find this player's fingerprint(s) for this format among stored replays
    // (there may be more than one if they've piloted multiple builds).
    const fingerprints = new Set<string>();
    for (const r of store.replays) {
      if (r.formatid !== scoutedFormatid) continue;
      for (const t of r.teams) {
        if (toID(t.player) === playerId) fingerprints.add(teamFingerprint(t.sets));
      }
    }
    for (const fp of fingerprints) {
      const groupKey = `${playerId}|${scoutedFormatid}|${fp}`;
      if (seen.has(groupKey)) continue;
      seen.add(groupKey);
      const r = aggregateGroup(store, playerId, scoutedFormatid, fp);
      if (r.replaysUpdated > 0) {
        groups++;
        replaysUpdated += r.replaysUpdated;
      }
    }
  }
  return { groups, replaysUpdated };
}
