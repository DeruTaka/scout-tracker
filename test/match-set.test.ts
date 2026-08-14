import { describe, it, expect } from 'vitest';
import { matchSet, itemWouldReveal } from '../src/match/match-set.js';
import { getGen } from '../src/data/dex.js';
import type { DexSet, RevealedMon } from '../src/types.js';

const gen = getGen(9);

function mon(overrides: Partial<RevealedMon> = {}): RevealedMon {
  return {
    player: 'tester',
    side: 'p1',
    species: 'Kyogre',
    baseSpecies: 'Kyogre',
    level: 100,
    shiny: false,
    moves: ['Origin Pulse'],
    itemHistory: [],
    fainted: false,
    ...overrides,
  };
}

function dexSet(item: string, ability?: string): DexSet {
  return {
    role: 'Test',
    moves: ['Origin Pulse'],
    movepool: ['Origin Pulse'],
    item,
    ability,
    nature: 'Modest',
    evs: { spa: 252, spe: 252, hp: 4 },
  };
}

describe('itemWouldReveal', () => {
  it('flags items that announce themselves in the log', () => {
    expect(itemWouldReveal('Air Balloon', 'Drizzle')).toBe(true);
    expect(itemWouldReveal('Life Orb', 'Drizzle')).toBe(true); // recoil visible
    expect(itemWouldReveal('Life Orb', 'Magic Guard')).toBe(false); // recoil suppressed
    expect(itemWouldReveal('Choice Specs', 'Drizzle')).toBe(false);
    expect(itemWouldReveal(undefined, 'Drizzle')).toBe(false);
  });
});

describe('matchSet does not force self-revealing items from priors', () => {
  it('drops an unrevealed Air Balloon prior', () => {
    const ms = matchSet(gen, mon(), [dexSet('Air Balloon')]);
    expect(ms.item).toBeUndefined();
    expect(ms.itemRevealed).toBe(false);
  });

  it('drops an unrevealed Life Orb prior for a non-Magic-Guard mon', () => {
    const ms = matchSet(gen, mon(), [dexSet('Life Orb', 'Drizzle')]);
    expect(ms.item).toBeUndefined();
  });

  it('keeps a Life Orb prior when the mon has Magic Guard', () => {
    const ms = matchSet(gen, mon({ species: 'Clefable', baseSpecies: 'Clefable' }), [
      dexSet('Life Orb', 'Magic Guard'),
    ]);
    expect(ms.item).toBe('Life Orb');
  });

  it('keeps a revealed item even if it would normally self-reveal', () => {
    const ms = matchSet(gen, mon({ item: 'Air Balloon' }), [dexSet('Choice Specs')]);
    expect(ms.item).toBe('Air Balloon');
    expect(ms.itemRevealed).toBe(true);
  });

  it('keeps a non-self-revealing prior item', () => {
    const ms = matchSet(gen, mon(), [dexSet('Choice Specs')]);
    expect(ms.item).toBe('Choice Specs');
    expect(ms.itemRevealed).toBe(false);
  });
});
