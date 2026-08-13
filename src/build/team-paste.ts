// Assemble full-team importable pastes from scouted sets.
import type { MatchedSet } from '../types.js';
import { exportSet } from './pokemon-set.js';

/** A full 6-mon importable team paste (blank line between sets). */
export function exportTeam(sets: MatchedSet[]): string {
  return sets.map((s) => exportSet(s)).join('\n\n') + '\n';
}
