// Mines stored replays for "how have real scouted games actually gone
// against decks like this" — independent of any one trainer. For every
// replay where the OPPOSING side fielded 2+ of the given threat species, tally
// win/loss per species on the OTHER side. A loose containment count, not
// aggregate.ts's teamFingerprint (that's exact-roster equality, built for a
// different job — detecting "same team piloted again").
import type { Datastore } from '../store/datastore.js';
import { toID } from '../data/dex.js';

export interface WinRate {
  wins: number;
  total: number;
}

const MIN_THREAT_OVERLAP = 2;

export function getHistoricalWinRates(store: Datastore, formatid: string, threatIds: Set<string>): Map<string, WinRate> {
  const result = new Map<string, WinRate>();
  const bump = (id: string, won: boolean) => {
    const cur = result.get(id) ?? { wins: 0, total: 0 };
    cur.total++;
    if (won) cur.wins++;
    result.set(id, cur);
  };

  for (const r of store.replays) {
    if (r.formatid !== formatid || !r.winner || r.teams.length !== 2) continue;
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
        bump(toID(s.baseSpecies), won);
      }
    }
  }
  return result;
}
