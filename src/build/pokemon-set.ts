// Turn a MatchedSet into importable Showdown text and validate move legality
// against the generation's learnsets.
import { Sets } from '@pkmn/sets';
import type { Generation } from '@pkmn/data';
import type { MatchedSet } from '../types.js';
import { isMoveLegal } from '../data/dex.js';

/** Build the plain object @pkmn/sets expects from a MatchedSet. */
function toExport(ms: MatchedSet): Record<string, unknown> {
  return {
    name: ms.nickname && ms.nickname !== ms.species ? ms.nickname : undefined,
    species: ms.species,
    item: ms.item || undefined,
    ability: ms.ability || undefined,
    level: ms.level && ms.level !== 100 ? ms.level : undefined,
    gender: ms.gender && ms.gender !== 'N' ? ms.gender : undefined,
    shiny: ms.shiny || undefined,
    nature: ms.nature || undefined,
    evs: ms.evs,
    ivs: ms.ivs,
    moves: ms.moves,
    teraType: ms.tera || undefined,
  };
}

/** Single-Pokemon importable paste (the Showdown export format). */
export function exportSet(ms: MatchedSet): string {
  return Sets.exportSet(toExport(ms) as any).trimEnd();
}

/**
 * Check each final move against the species' learnset for this gen. Revealed
 * moves are trusted (they were used in-game); only dex-filled moves can be
 * flagged. Returns the list of illegal filled-in moves (usually empty).
 */
export async function illegalFilledMoves(gen: Generation, ms: MatchedSet): Promise<string[]> {
  const revealed = new Set(ms.revealedMoves.map((m) => m.toLowerCase()));
  const bad: string[] = [];
  for (const move of ms.moves) {
    if (revealed.has(move.toLowerCase())) continue;
    if (!(await isMoveLegal(gen, ms.baseSpecies, move))) bad.push(move);
  }
  return bad;
}
