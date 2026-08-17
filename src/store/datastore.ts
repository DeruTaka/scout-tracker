// JSON-file datastore. Persists scouted replays and a per-trainer library of
// UNIQUE sets (unique by format / moves / item / ability / nature / EVs / tera /
// level / forme). Also serves historical + common-usage priors back into the
// scouting pipeline so repeat opponents get richer over time.
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DexSet, MatchedSet, ScoutedReplay, StatsTable } from '../types.js';
import { toID } from '../data/dex.js';

export interface StoredReplay {
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
  /** Full battle log, kept so damage evidence can be re-derived later (e.g. to
   *  pool it across replays of the same team) without re-fetching. */
  log: string;
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

/**
 * A manually-verified build for a (player, formatid, species) — e.g. a spread
 * confirmed outside what any single replay's damage evidence can pin down.
 * Lives separately from `uniqueSets` (which `rebuildUniqueSets` fully replaces
 * from replay data on every rebuild) so a pin survives that and persists until
 * explicitly removed. Consulted by `getPriorSets` ahead of scouted history.
 */
export interface PinnedSet {
  player: string;
  playerId: string;
  formatid: string;
  baseSpecies: string;
  set: MatchedSet;
  note?: string;
  pinnedAt: number;
}

interface StoreShape {
  version: 1;
  replays: Record<string, StoredReplay>;
  uniqueSets: UniqueSet[];
  pins: PinnedSet[];
}

export interface PlayerSpeciesUsage {
  species: string;
  baseSpecies: string;
  count: number; // times this species appeared across their scouted teams
  usagePercent: number; // % of their scouted teams (in scope) that included it
  topSet: MatchedSet; // their single most-common exact build for it
  items: { name: string; percent: number }[];
  abilities: { name: string; percent: number }[];
  natures: { name: string; percent: number }[];
  teras: { name: string; percent: number }[];
}

export interface PlayerUsage {
  player: string;
  playerId: string;
  formatid?: string;
  totalTeams: number;
  species: PlayerSpeciesUsage[];
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

function matchedToDexSet(ms: MatchedSet, role: string, verified = false): DexSet {
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
    verified,
  };
}

export class Datastore {
  private data: StoreShape;
  constructor(private path: string) {
    this.data = existsSync(path)
      ? (JSON.parse(readFileSync(path, 'utf8')) as StoreShape)
      : { version: 1, replays: {}, uniqueSets: [], pins: [] };
    if (!this.data.uniqueSets) this.data.uniqueSets = [];
    if (!this.data.replays) this.data.replays = {};
    if (!this.data.pins) this.data.pins = [];
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

  get pins(): PinnedSet[] {
    return this.data.pins;
  }

  /** Pin a manually-verified build, replacing any existing pin for the same
   *  (player, formatid, baseSpecies). Does not survive rebuildUniqueSets by
   *  design — it lives outside that replay-derived table. */
  addPin(player: string, formatid: string, set: MatchedSet, note?: string): PinnedSet {
    const playerId = toID(player);
    const baseSpecies = set.baseSpecies;
    this.data.pins = this.data.pins.filter(
      (p) => !(p.playerId === playerId && p.formatid === formatid && toID(p.baseSpecies) === toID(baseSpecies)),
    );
    const pin: PinnedSet = { player, playerId, formatid, baseSpecies, set, note, pinnedAt: Date.now() };
    this.data.pins.push(pin);
    return pin;
  }

  /** Remove a pin. Returns true if one was found and removed. */
  removePin(player: string, formatid: string, baseSpecies: string): boolean {
    const playerId = toID(player);
    const spId = toID(baseSpecies);
    const before = this.data.pins.length;
    this.data.pins = this.data.pins.filter(
      (p) => !(p.playerId === playerId && p.formatid === formatid && toID(p.baseSpecies) === spId),
    );
    return this.data.pins.length < before;
  }

  /** List pins, optionally narrowed to one player. */
  listPins(player?: string): PinnedSet[] {
    const pid = player ? toID(player) : undefined;
    return this.data.pins.filter((p) => !pid || p.playerId === pid);
  }

  /**
   * Candidate priors for a mon: a manually pinned build first (if any), then
   * this trainer's historical sets, then the most common sets for the species
   * across all trainers in the format.
   */
  getPriorSets = (player: string, formatid: string, baseSpecies: string): DexSet[] => {
    const pid = toID(player);
    const spId = toID(baseSpecies);
    const out: DexSet[] = [];

    const pin = this.data.pins.find(
      (p) => p.playerId === pid && p.formatid === formatid && toID(p.baseSpecies) === spId,
    );
    if (pin) out.push(matchedToDexSet(pin.set, `Pinned: ${pin.player}${pin.note ? ` (${pin.note})` : ''}`, true));

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

  /**
   * This trainer's own usage stats, computed purely from what we've scouted of
   * them — same shape as Smogon's usage stats (species usage%, item/ability/
   * nature/tera breakdowns) but scoped to one player. `formatid` optionally
   * narrows to one metagame; omitted, it spans everything stored for them.
   */
  getPlayerUsage(player: string, formatid?: string): PlayerUsage | null {
    const pid = toID(player);
    const sets = this.data.uniqueSets.filter((u) => u.playerId === pid && (!formatid || u.formatid === formatid));
    if (sets.length === 0) return null;

    const teamIds = new Set<string>();
    for (const r of Object.values(this.data.replays)) {
      if (formatid && r.formatid !== formatid) continue;
      if (r.teams.some((t) => toID(t.player) === pid)) teamIds.add(r.id);
    }
    const totalTeams = teamIds.size;

    const bySpecies = new Map<string, UniqueSet[]>();
    for (const u of sets) {
      const k = toID(u.baseSpecies);
      (bySpecies.get(k) ?? bySpecies.set(k, []).get(k)!).push(u);
    }

    const tally = (group: UniqueSet[], totalUses: number, pick: (u: UniqueSet) => string | undefined) => {
      const m = new Map<string, number>();
      for (const u of group) {
        const v = pick(u);
        if (!v) continue;
        m.set(v, (m.get(v) || 0) + u.count);
      }
      return [...m.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([name, n]) => ({ name, percent: (n / totalUses) * 100 }));
    };

    const species: PlayerSpeciesUsage[] = [];
    for (const group of bySpecies.values()) {
      const totalUses = group.reduce((s, u) => s + u.count, 0);
      const top = [...group].sort((a, b) => b.count - a.count)[0]!;
      species.push({
        species: top.species,
        baseSpecies: top.baseSpecies,
        count: totalUses,
        usagePercent: totalTeams ? (totalUses / totalTeams) * 100 : 0,
        topSet: top.set,
        items: tally(group, totalUses, (u) => u.set.item),
        abilities: tally(group, totalUses, (u) => u.set.ability),
        natures: tally(group, totalUses, (u) => u.set.nature),
        teras: tally(group, totalUses, (u) => u.set.tera),
      });
    }
    species.sort((a, b) => b.usagePercent - a.usagePercent);

    return { player: sets[0]!.player, playerId: pid, formatid, totalTeams, species };
  }

  /** Store a scouted replay. Does NOT fold the unique-set library — call
   *  rebuildUniqueSets() after (aggregation may still revise these sets). */
  ingest(scouted: ScoutedReplay): { replayNew: boolean } {
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
      log: r.log,
    };
    return { replayNew };
  }

  /**
   * Rebuild the unique-set library from scratch from currently-stored replays.
   * Full rebuild (rather than incremental merge) keeps it consistent even after
   * cross-replay aggregation revises a set's EVs/item on existing replays.
   */
  rebuildUniqueSets(): void {
    const byKey = new Map<string, UniqueSet>();
    for (const r of Object.values(this.data.replays)) {
      for (const team of r.teams) {
        const playerId = toID(team.player);
        for (const ms of team.sets) {
          if (ms.unrevealed) continue; // don't pollute the library with empty sets
          const hash = setHash(r.formatid, ms);
          const mapKey = `${hash}|${playerId}`;
          const existing = byKey.get(mapKey);
          if (existing) {
            if (!existing.sources.includes(r.id)) {
              existing.sources.push(r.id);
              existing.count++;
              existing.lastSeen = Math.max(existing.lastSeen, r.uploadtime);
              existing.firstSeen = Math.min(existing.firstSeen, r.uploadtime);
            }
          } else {
            byKey.set(mapKey, {
              hash,
              player: team.player,
              playerId,
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
          }
        }
      }
    }
    this.data.uniqueSets = [...byKey.values()];
  }

  save(): void {
    const dir = dirname(this.path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.path);
  }
}
