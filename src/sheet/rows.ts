// Build the tabular data (three tabs) that both the xlsx and Google Sheets
// writers render. One place defines columns + formatting.
import type { MatchedSet, StatsTable } from '../types.js';
import type { Datastore, UniqueSet } from '../store/datastore.js';
import { exportSet } from '../build/pokemon-set.js';

export interface Sheet {
  name: string;
  header: string[];
  rows: (string | number)[][];
}

const STAT_LABEL: Record<keyof StatsTable, string> = {
  hp: 'HP', atk: 'Atk', def: 'Def', spa: 'SpA', spd: 'SpD', spe: 'Spe',
};

export function evsToString(evs: Partial<StatsTable> = {}): string {
  const parts: string[] = [];
  for (const k of ['hp', 'atk', 'def', 'spa', 'spd', 'spe'] as const) {
    if (evs[k]) parts.push(`${evs[k]} ${STAT_LABEL[k]}`);
  }
  return parts.join(' / ') || '(none)';
}

function isoDate(unix: number): string {
  return unix ? new Date(unix * 1000).toISOString().slice(0, 10) : '';
}

function result(winner: string | undefined, player: string): string {
  if (!winner) return '';
  return winner === player ? 'W' : 'L';
}

function movesLabel(ms: MatchedSet): string {
  return ms.moves.join(', ');
}

const SETS_HEADER = [
  'Replay', 'URL', 'Format', 'Date', 'Trainer', 'Result', 'Pokemon',
  'Revealed Moves', 'Matched Set', 'Final Moves', 'Ability', 'Item', 'Tera',
  'Nature', 'EVs', 'EV Source', 'Confidence', 'Notes', 'Importable',
];

const TEAMS_HEADER = ['Replay', 'URL', 'Format', 'Date', 'Trainer', 'Result', 'Team Paste'];

const UNIQUE_HEADER = [
  'Trainer', 'Format', 'Pokemon', 'Times Seen', 'First Seen', 'Last Seen',
  'Moves', 'Ability', 'Item', 'Tera', 'Nature', 'EVs', 'Confidence',
  'Source Replays', 'Importable',
];

export function buildSheets(store: Datastore): Sheet[] {
  const setsRows: (string | number)[][] = [];
  const teamsRows: (string | number)[][] = [];

  for (const r of store.replays) {
    for (const team of r.teams) {
      teamsRows.push([
        r.id, r.url, r.format, isoDate(r.uploadtime), team.player,
        result(r.winner, team.player), team.paste,
      ]);
      for (const ms of team.sets) {
        setsRows.push([
          r.id, r.url, r.format, isoDate(r.uploadtime), team.player,
          result(r.winner, team.player), ms.species,
          ms.revealedMoves.join(', '), ms.matchedRole ?? '(none)', movesLabel(ms),
          ms.ability ?? '', ms.item ?? '', ms.tera ?? '', ms.nature,
          evsToString(ms.evs), ms.evSource, ms.confidence.toFixed(2),
          ms.notes.join(' | '), exportSet(ms),
        ]);
      }
    }
  }

  const uniqueRows: (string | number)[][] = [...store.uniqueSets]
    .sort((a, b) => a.player.localeCompare(b.player) || a.species.localeCompare(b.species) || b.count - a.count)
    .map((u: UniqueSet) => [
      u.player, u.format, u.species, u.count, isoDate(u.firstSeen), isoDate(u.lastSeen),
      u.set.moves.join(', '), u.set.ability ?? '', u.set.item ?? '', u.set.tera ?? '',
      u.set.nature, evsToString(u.set.evs), u.set.confidence.toFixed(2),
      u.sources.join(' '), exportSet(u.set),
    ]);

  return [
    { name: 'Sets', header: SETS_HEADER, rows: setsRows },
    { name: 'Teams', header: TEAMS_HEADER, rows: teamsRows },
    { name: 'UniqueSets', header: UNIQUE_HEADER, rows: uniqueRows },
  ];
}
