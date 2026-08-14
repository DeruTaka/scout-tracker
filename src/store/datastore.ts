// JSON-file datastore. Persists scouted replays and a per-trainer library of
// UNIQUE sets (unique by format / moves / item / ability / nature / EVs / tera /
// level / forme). Also serves historical + common-usage priors back into the
// scouting pipeline so repeat opponents get richer over time.
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DexSet, MatchedSet, ScoutedReplay, StatsTable } from '../types.js';
import { toID } from '../data/dex.js';

interface StoredReplay {
  id: string;
  url: string;
  format: string;
  formatid: string;
  gen: number;
  players: string[];
  uploadtime: number;
  winner?: string;
  scoutedAt: number;
  teams: { player: string; side: 'p1' | 'p2'; sets: MatchedSet[]; paste: string }[];
}

export interface UniqueSet {
  hash: string;
  player: string;
  playerId: string;
  formatid: string;
  format: string;
  baseSpecies: string;
  species: string;
  set: MatchedSet;
  count: number;
  sources: string[]; // replay ids
  firstSeen: number;
  lastSeen: number;
}

interface StoreShape {
  version: 1;
  replays: Record<string, StoredReplay>;
  uniqueSets: UniqueSet[];
}

function evString(evs: Partial<StatsTable> = {}): string {
  return (['hp', 'atk', 'def', 'spa', 'spd', 'spe'] as const).map((k) => evs[k] || 0).join('/');
}

/** Canonical identity of a set — two sets with the same hash are "the same". */
export function setHash(formatid: string, ms: MatchedSet): string {
  const moves = [...ms.moves].map(toID).sort().join(',');
  return [
    formatid,
    toID(ms.species),
    moves,
    toID(ms.item || ''),
    toID(ms.ability || ''),
    toID(ms.nature || ''),
    toID(ms.tera || ''),
    ms.level || 100,
    evString(ms.evs),
  ].join('|');
}

function matchedToDexSet(ms: MatchedSet, role: string): DexSet {
  return {
    role,
    moves: ms.moves.map((m) => m), // fixed slots
    movepool: [...ms.moves],
    ability: ms.ability,
    item: ms.item,
    nature: ms.nature,
    teratypes: ms.tera,
    evs: ms.evs,
    ivs: ms.ivs,
    level: ms.level,
  };
}

export class Datastore {
  private data: StoreShape;
  constructor(private path: string) {
    this.data = existsSync(path)
      ? (JSON.parse(readFileSync(path, 'utf8')) as StoreShape)
      : { version: 1, replays: {}, uniqueSets: [] };
    if (!this.data.uniqueSets) this.data.uniqueSets = [];
    if (!this.data.replays) this.data.replays = {};
  }

  hasReplay(id: string): boolean {
    return !!this.data.replays[id];
  }

  get replays(): StoredReplay[] {
    return Object.values(this.data.replays).sort((a, b) => b.uploadtime - a.uploadtime);
  }

  get uniqueSets(): UniqueSet[] {
    return this.data.uniqueSets;
  }

  /**
   * Candidate priors for a mon: this trainer's historical sets first, then the
   * most common sets for the species across all trainers in the format.
   */
  getPriorSets = (player: string, formatid: string, baseSpecies: string): DexSet[] => {
    const pid = toID(player);
    const spId = toID(baseSpecies);
    const out: DexSet[] = [];

    const own = this.data.uniqueSets
      .filter((u) => u.playerId === pid && u.formatid === formatid && toID(u.set.species) === spId)
      .sort((a, b) => b.count - a.count || b.lastSeen - a.lastSeen);
    for (const u of own) {
      out.push(matchedToDexSet(u.set, `History: ${u.player} ×${u.count}`));
    }

    // Common usage across everyone (excluding this trainer's already-added ones).
    const seenHashes = new Set(own.map((u) => u.hash));
    const common = this.data.uniqueSets
      .filter((u) => u.formatid === formatid && toID(u.set.species) === spId && !seenHashes.has(u.hash))
      .sort((a, b) => b.count - a.count || b.lastSeen - a.lastSeen)
      .slice(0, 3);
    for (const u of common) out.push(matchedToDexSet(u.set, `Common ×${u.count}`));

    return out;
  };

  /** Store a scouted replay + fold its sets into the unique-set library. */
  ingest(scouted: ScoutedReplay): { replayNew: boolean; newSets: number; updatedSets: number } {
    const r = scouted.replay;
    const replayNew = !this.data.replays[r.id];
    this.data.replays[r.id] = {
      id: r.id,
      url: r.url,
      format: r.format,
      formatid: r.formatid,
      gen: r.gen,
      players: r.players,
      uploadtime: r.uploadtime,
      winner: r.winner,
      scoutedAt: scouted.scoutedAt,
      teams: scouted.teams.map((t) => ({ player: t.player, side: t.side, sets: t.sets, paste: t.paste })),
    };

    let newSets = 0;
    let updatedSets = 0;
    for (const team of scouted.teams) {
      for (const ms of team.sets) {
        if (ms.unrevealed) continue; // don't pollute the library with empty sets
        const hash = setHash(r.formatid, ms);
        const existing = this.data.uniqueSets.find(
          (u) => u.hash === hash && u.playerId === toID(team.player),
        );
        if (existing) {
          if (!existing.sources.includes(r.id)) {
            existing.sources.push(r.id);
            existing.count++;
            existing.lastSeen = Math.max(existing.lastSeen, r.uploadtime);
            existing.firstSeen = Math.min(existing.firstSeen, r.uploadtime);
            updatedSets++;
          }
        } else {
          this.data.uniqueSets.push({
            hash,
            player: team.player,
            playerId: toID(team.player),
            formatid: r.formatid,
            format: r.format,
            baseSpecies: ms.baseSpecies,
            species: ms.species,
            set: ms,
            count: 1,
            sources: [r.id],
            firstSeen: r.uploadtime,
            lastSeen: r.uploadtime,
          });
          newSets++;
        }
      }
    }
    return { replayNew, newSets, updatedSets };
  }

  save(): void {
    const dir = dirname(this.path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.path);
  }
}
