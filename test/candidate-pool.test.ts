import { describe, it, expect } from 'vitest';
import { getGen } from '../src/data/dex.js';
import { fillRealisticSet, type KnownSet } from '../src/matchup/candidate-pool.js';
import type { MatchedSet } from '../src/types.js';

const gen = getGen(9);

function mon(overrides: Partial<MatchedSet>): MatchedSet {
  return {
    species: overrides.species!,
    baseSpecies: overrides.baseSpecies ?? overrides.species!,
    level: 100,
    shiny: false,
    moves: [],
    revealedMoves: [],
    item: undefined,
    itemRevealed: false,
    ability: undefined,
    nature: 'Serious',
    evs: {},
    confidence: 0.7,
    notes: [],
    evSource: 'derived',
    choicePossible: true,
    ...overrides,
  };
}

describe('fillRealisticSet', () => {
  it('pads a thinly-revealed local set (1 move, no spread) to a full, real, playable build', async () => {
    // A real, heavily-tracked Ubers staple — guaranteed to have Smogon usage
    // data to fall back on. Only one move + no EV evidence, matching exactly
    // what a lightly-scouted replay leaves behind.
    const thin: KnownSet = { set: mon({ species: 'Kingambit', baseSpecies: 'Kingambit', moves: ['Sucker Punch'], revealedMoves: ['Sucker Punch'], evs: {} }), source: 'store', localCount: 1 };
    const filled = await fillRealisticSet(gen, 'gen9ubers', thin);

    expect(filled.set.moves).toContain('Sucker Punch'); // never drops what was actually observed
    expect(filled.set.moves.length).toBe(4);
    expect(new Set(filled.set.moves).size).toBe(4); // no duplicate padding
    const evTotal = Object.values(filled.set.evs).reduce((s, v) => s + (v ?? 0), 0);
    expect(evTotal).toBeGreaterThanOrEqual(500);
    expect(filled.set.notes.some((n) => n.includes('Filled out to a full moveset'))).toBe(true);
    expect(filled.set.notes.some((n) => n.includes('Spread filled'))).toBe(true);
  }, 15000);

  it('leaves an already-complete set untouched', async () => {
    const complete: KnownSet = {
      set: mon({
        species: 'Kingambit', baseSpecies: 'Kingambit',
        moves: ['Sucker Punch', 'Kowtow Cleave', 'Iron Head', 'Swords Dance'],
        revealedMoves: ['Sucker Punch', 'Kowtow Cleave', 'Iron Head', 'Swords Dance'],
        evs: { hp: 248, atk: 252, spd: 8 },
      }),
      source: 'store',
      localCount: 5,
    };
    const filled = await fillRealisticSet(gen, 'gen9ubers', complete);
    expect(filled).toBe(complete); // returned as-is, no fetch needed
  });
});
