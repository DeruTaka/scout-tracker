import { describe, it, expect } from 'vitest';
import { matchSet, itemWouldReveal, isUnrevealed } from '../src/match/match-set.js';
import { exportSet } from '../src/build/pokemon-set.js';
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
    appeared: true,
    usedMultipleMoves: false,
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

describe('never-appeared mons are left empty, not guessed', () => {
  const blank = mon({ moves: [], appeared: false }); // team-preview only

  it('detects a mon that never switched in', () => {
    expect(isUnrevealed(blank)).toBe(true);
    expect(isUnrevealed(mon({ appeared: true }))).toBe(false);
  });

  it('emits an empty set instead of dex-filling it', () => {
    const ms = matchSet(gen, blank, [dexSet('Choice Specs')]);
    expect(ms.unrevealed).toBe(true);
    expect(ms.moves).toEqual([]);
    expect(ms.item).toBeUndefined();
    expect(ms.ability).toBeUndefined();
    expect(ms.evs).toEqual({});
    // Paste is just the species — no hallucinated moves/spread.
    expect(exportSet(ms)).toBe('Kyogre');
  });
});

describe('move-filling is gated on 3+ revealed moves matching a dex set', () => {
  const bigSet: DexSet = {
    role: 'Test',
    moves: ['Ice Beam', 'Thunder', 'Origin Pulse', 'Water Spout'],
    movepool: ['Ice Beam', 'Thunder', 'Origin Pulse', 'Water Spout', 'Calm Mind'],
    item: 'Choice Specs',
    nature: 'Modest',
    evs: { spa: 252, spe: 252 },
    teratypes: 'Water',
  };

  it('completes the moveset when 3 revealed moves line up', () => {
    const ms = matchSet(gen, mon({ moves: ['Ice Beam', 'Thunder', 'Origin Pulse'] }), [bigSet]);
    expect(ms.moves.length).toBe(4);
    expect(ms.moves).toContain('Water Spout'); // filled 4th slot
    expect(ms.tera).toBe('Water'); // full set is confident -> tera guessed too
  });

  it('shows only revealed moves when fewer than 3 revealed — but keeps EV/item prediction', () => {
    const ms = matchSet(gen, mon({ moves: ['Ice Beam', 'Thunder'] }), [bigSet]);
    expect(ms.moves).toEqual(['Ice Beam', 'Thunder']);
    expect(ms.item).toBe('Choice Specs');
    expect(ms.evs.spa).toBe(252);
    expect(ms.tera).toBeUndefined(); // set isn't confident -> don't guess tera either
    expect(ms.notes.some((n) => n.includes('Tera type left blank'))).toBe(true);
  });

  it('does not complete the set when a revealed move is outside the dex set', () => {
    const ms = matchSet(gen, mon({ moves: ['Ice Beam', 'Thunder', 'Surf'] }), [bigSet]);
    expect(ms.moves).toEqual(['Ice Beam', 'Thunder', 'Surf']); // no bogus 4th move
    expect(ms.tera).toBeUndefined();
  });

  it('always keeps a directly-revealed tera regardless of how confident the rest of the set is', () => {
    const ms = matchSet(gen, mon({ moves: ['Ice Beam'], tera: 'Ghost' }), [bigSet]);
    expect(ms.tera).toBe('Ghost');
  });
});

describe('Choice items are ruled out when the mon used 2+ moves in one stay-in', () => {
  it('drops a Choice prior item for a multi-move mon', () => {
    const ms = matchSet(gen, mon({ usedMultipleMoves: true }), [dexSet('Choice Specs')]);
    expect(ms.item).toBeUndefined();
    expect(ms.choicePossible).toBe(false);
  });

  it('keeps a Choice prior item for a single-move mon', () => {
    const ms = matchSet(gen, mon({ usedMultipleMoves: false }), [dexSet('Choice Specs')]);
    expect(ms.item).toBe('Choice Specs');
    expect(ms.choicePossible).toBe(true);
  });
});
