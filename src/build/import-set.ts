// Parse a Pokemon Showdown export-format paste into a MatchedSet — the
// reverse of pokemon-set.ts's exportSet. Used for manually PINNING a
// known-correct build (see `scout pin`): unlike a scouted set, everything
// here is taken as verified ground truth, not inferred from replay evidence.
import { Sets } from '@pkmn/sets';
import type { PokemonSet } from '@pkmn/sets';
import type { Generation } from '@pkmn/data';
import type { MatchedSet } from '../types.js';
import { resolveSpecies } from '../data/dex.js';

/** Map one `@pkmn/sets`-parsed set into a MatchedSet, treating it as fully
 *  verified (no inference — every field came straight from the paste text).
 *  Shared by `parsePasteToMatchedSet` (one mon) and `import-team.ts` (a
 *  full multi-mon team paste). */
export function matchedSetFromImported(gen: Generation, parsed: Partial<PokemonSet>, notes: string[]): MatchedSet {
  if (!parsed.species) throw new Error('Could not parse a species from the paste text.');
  const { display, setKey } = resolveSpecies(gen, parsed.species);
  const moves = (parsed.moves || []).filter((m): m is string => !!m);
  if (moves.length === 0) throw new Error(`${parsed.species} has no moves in the paste.`);

  return {
    species: display,
    baseSpecies: setKey,
    nickname: parsed.name && parsed.name !== parsed.species ? parsed.name : undefined,
    gender: (parsed.gender as 'M' | 'F' | 'N' | undefined) || undefined,
    level: parsed.level || 100,
    shiny: !!parsed.shiny,
    moves,
    revealedMoves: [...moves], // pinned = fully verified, treat as if all were seen
    item: parsed.item || undefined,
    itemRevealed: true,
    ability: parsed.ability || undefined,
    nature: parsed.nature || 'Serious',
    evs: parsed.evs || {},
    ivs: parsed.ivs,
    tera: parsed.teraType || undefined,
    confidence: 1,
    notes,
    evSource: 'derived',
    choicePossible: true,
  };
}

export function parsePasteToMatchedSet(gen: Generation, pasteText: string): MatchedSet {
  const parsed = Sets.importSet(pasteText.trim());
  return matchedSetFromImported(gen, parsed, ['Manually pinned as a verified build.']);
}
