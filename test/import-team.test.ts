import { describe, it, expect } from 'vitest';
import { parsePasteToTeam, parsePasteToTeams } from '../src/build/import-team.js';
import { getGen } from '../src/data/dex.js';

const gen = getGen(9);

const SINGLE_TEAM = `
Koraidon @ Loaded Dice
Ability: Orichalcum Pulse
EVs: 252 Atk / 4 Def / 252 Spe
Jolly Nature
- Scale Shot
- Low Kick
- Swords Dance
- Flare Blitz

Zacian-Crowned @ Rusted Sword
Ability: Intrepid Sword
EVs: 252 Atk / 4 Def / 252 Spe
Jolly Nature
- Behemoth Blade
`;

describe('parsePasteToTeam', () => {
  it('parses every mon in a standard multi-mon export', () => {
    const team = parsePasteToTeam(gen, SINGLE_TEAM);
    expect(team.length).toBe(2);
    const kora = team.find((m) => m.baseSpecies === 'Koraidon');
    expect(kora).toBeTruthy();
    expect(kora!.moves).toContain('Scale Shot');
    expect(kora!.evs.spe).toBe(252);
    expect(kora!.item).toBe('Loaded Dice');
  });
});

describe('parsePasteToTeams', () => {
  it('splits a multi-team paste on "=== [Title] ===" headers', () => {
    const paste = `=== [gen9ubers] Team A ===\n${SINGLE_TEAM}\n=== [gen9ubers] Team B ===\n${SINGLE_TEAM}`;
    const teams = parsePasteToTeams(gen, paste);
    expect(teams.length).toBe(2);
    expect(teams[0]!.length).toBe(2);
    expect(teams[1]!.length).toBe(2);
  });

  it('returns [] for text with no recognizable team', () => {
    expect(parsePasteToTeams(gen, 'not a pokemon paste at all')).toEqual([]);
  });
});
