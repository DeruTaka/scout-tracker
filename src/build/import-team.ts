// Parse a standard Showdown-export-format PokePaste (one team, or several
// teams separated by "=== [Title] ===" headers) into MatchedSet[] per team.
// Complements import-set.ts's single-mon parser: @pkmn/sets' Teams.importTeam
// / importTeams already handle the blank-line-per-mon and "===" multi-team
// splitting, so this just maps each resulting parsed mon through the same
// verified-ground-truth logic as a pinned set.
import { Teams } from '@pkmn/sets';
import type { Generation } from '@pkmn/data';
import type { MatchedSet } from '../types.js';
import { matchedSetFromImported } from './import-set.js';

/** Parse the first (or only) team in `pasteText`. Returns [] if nothing
 *  recognizable as a standard team-export paste was found. */
export function parsePasteToTeam(gen: Generation, pasteText: string): MatchedSet[] {
  const team = Teams.importTeam(pasteText.trim());
  if (!team || team.team.length === 0) return [];
  const out: MatchedSet[] = [];
  for (const mon of team.team) {
    try {
      out.push(matchedSetFromImported(gen, mon, ['Imported from a PokePaste.']));
    } catch {
      // A mon that failed to resolve (bad species, no moves) is skipped
      // rather than aborting the whole team.
    }
  }
  return out;
}

/** Parse every team in a multi-team PokePaste ("=== [Title] ===" sections,
 *  or several blank-line-separated teams with no headers). */
export function parsePasteToTeams(gen: Generation, pasteText: string): MatchedSet[][] {
  const teams = Teams.importTeams(pasteText.trim());
  const out: MatchedSet[][] = [];
  for (const team of teams) {
    const sets: MatchedSet[] = [];
    for (const mon of team.team) {
      try {
        sets.push(matchedSetFromImported(gen, mon, ['Imported from a PokePaste.']));
      } catch {
        /* skip unresolvable mon */
      }
    }
    if (sets.length) out.push(sets);
  }
  return out;
}
