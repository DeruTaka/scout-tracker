// Mines stored replays for "how have real scouted games actually gone
// against decks like this" — independent of any one trainer. For every
// replay where the OPPOSING side fielded 2+ of the given threat species, tally
// win/loss per species on the OTHER side. A loose containment count, not
// aggregate.ts's teamFingerprint (that's exact-roster equality, built for a
// different job — detecting "same team piloted again").
import type { Datastore } from '../store/datastore.js';
import { toID } from '../data/dex.js';

export interface WinRate {
  wins: number; // raw counts — for display ("Historically 9-7")
  total: number;
  /** Recency-weighted win%, 0..100 — what actually drives scoring. A win
   *  from last week counts close to full; the same win from months ago
   *  counts for much less, per RECENCY_HALF_LIFE_DAYS. */
  weightedWinPercent: number;
}

const MIN_THREAT_OVERLAP = 2;
// A game half this many days older than the trainer's most recent scouted
// game (in this format) counts half as much toward the win-rate signal.
// Gentle enough that a month-old result still matters, but this month's
// results dominate — metagames and a given trainer's own habits shift.
const RECENCY_HALF_LIFE_DAYS = 30;
const SECONDS_PER_DAY = 86400;

export function getHistoricalWinRates(store: Datastore, formatid: string, threatIds: Set<string>): Map<string, WinRate> {
  const relevant = store.replays.filter((r) => r.formatid === formatid && r.winner && r.teams.length === 2);
  if (!relevant.length) return new Map();
  const mostRecent = Math.max(...relevant.map((r) => r.uploadtime));

  const recencyWeight = (uploadtime: number): number => {
    const daysOld = Math.max(0, (mostRecent - uploadtime) / SECONDS_PER_DAY);
    return 0.5 ** (daysOld / RECENCY_HALF_LIFE_DAYS);
  };

  const raw = new Map<string, { wins: number; total: number; weightedWins: number; weightedTotal: number }>();
  const bump = (id: string, won: boolean, weight: number) => {
    const cur = raw.get(id) ?? { wins: 0, total: 0, weightedWins: 0, weightedTotal: 0 };
    cur.total++;
    cur.weightedTotal += weight;
    if (won) {
      cur.wins++;
      cur.weightedWins += weight;
    }
    raw.set(id, cur);
  };

  for (const r of relevant) {
    const weight = recencyWeight(r.uploadtime);
    const [a, b] = r.teams as [(typeof r.teams)[0], (typeof r.teams)[0]];
    for (const [mine, opp] of [
      [a, b],
      [b, a],
    ] as const) {
      const overlap = opp.sets.filter((s) => threatIds.has(toID(s.baseSpecies))).length;
      if (overlap < MIN_THREAT_OVERLAP) continue;
      const won = r.winner === mine.player;
      for (const s of mine.sets) {
        if (s.unrevealed) continue;
        bump(toID(s.baseSpecies), won, weight);
      }
    }
  }

  const result = new Map<string, WinRate>();
  for (const [id, v] of raw) {
    result.set(id, {
      wins: v.wins,
      total: v.total,
      weightedWinPercent: v.weightedTotal ? (v.weightedWins / v.weightedTotal) * 100 : 0,
    });
  }
  return result;
}
