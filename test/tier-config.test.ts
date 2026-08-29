import { describe, it, expect } from 'vitest';
import { getGen } from '../src/data/dex.js';
import { getTierConfig } from '../src/matchup/tier-config.js';
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

describe('getTierConfig', () => {
  it('falls back to the generic config for an unrecognized format', () => {
    const config = getTierConfig('gen9somethingmadeup');
    expect(config.mandatorySpecies).toEqual([]);
    expect(config.trustCuratedLegality).not.toBe(true);
  });

  it('returns the real gen9ubers config, distinct from gen9nationaldexubers', () => {
    const ubers = getTierConfig('gen9ubers');
    const natdex = getTierConfig('gen9nationaldexubers');
    expect(ubers.mandatorySpecies).toEqual(['Koraidon']);
    expect(natdex.mandatorySpecies).toEqual(['Groudon-Primal']);
    expect(natdex.trustCuratedLegality).toBe(true);
    expect(ubers.trustCuratedLegality).not.toBe(true);
  });
});

describe('tier-config requirements', () => {
  const natdex = getTierConfig('gen9nationaldexubers');
  const ubers = getTierConfig('gen9ubers');

  it('typeRequirement matches by real type, and by Tera when allowed', () => {
    const steelReq = ubers.requirements.find((r) => r.label === 'Steel type')!;
    expect(steelReq).toBeDefined();
    expect(steelReq.satisfies(gen, { species: 'Kingambit', set: mon({ species: 'Kingambit', baseSpecies: 'Kingambit' }) })).toBe(true);
    expect(steelReq.satisfies(gen, { species: 'Charizard', set: mon({ species: 'Charizard', baseSpecies: 'Charizard' }) })).toBe(false);

    const fairyReq = ubers.requirements.find((r) => r.label.startsWith('Fairy'))!;
    expect(fairyReq.satisfies(gen, { species: 'Charizard', set: mon({ species: 'Charizard', baseSpecies: 'Charizard', tera: 'Fairy' }) })).toBe(true);
  });

  it('typeOrSpeciesRequirement is satisfied by Marshadow even though it is not Dark-typed', () => {
    const darkReq = natdex.requirements.find((r) => r.label.includes('Marshadow'))!;
    expect(darkReq).toBeDefined();
    expect(darkReq.satisfies(gen, { species: 'Marshadow', set: mon({ species: 'Marshadow', baseSpecies: 'Marshadow' }) })).toBe(true);
    expect(darkReq.satisfies(gen, { species: 'Charizard', set: mon({ species: 'Charizard', baseSpecies: 'Charizard' }) })).toBe(false);
    expect(darkReq.satisfies(gen, { species: 'Chien-Pao', set: mon({ species: 'Chien-Pao', baseSpecies: 'Chien-Pao', tera: 'Dark' }) })).toBe(true);
  });

  it('speedControlRequirement accepts Trick Room, Tailwind, and Choice Scarf', () => {
    const speedReq = natdex.requirements.find((r) => r.label.startsWith('speed control'))!;
    expect(speedReq.satisfies(gen, { species: 'Torkoal', set: mon({ species: 'Torkoal', baseSpecies: 'Torkoal', moves: ['Trick Room'] }) })).toBe(true);
    expect(speedReq.satisfies(gen, { species: 'Whimsicott', set: mon({ species: 'Whimsicott', baseSpecies: 'Whimsicott', moves: ['Tailwind'] }) })).toBe(true);
    expect(speedReq.satisfies(gen, { species: 'Ditto', set: mon({ species: 'Ditto', baseSpecies: 'Ditto', item: 'Choice Scarf' }) })).toBe(true);
    expect(speedReq.satisfies(gen, { species: 'Blissey', set: mon({ species: 'Blissey', baseSpecies: 'Blissey', moves: ['Soft-Boiled'] }) })).toBe(false);
  });

  it('vrListViability rejects D-tier species and accepts everything above it', () => {
    const shaymin = natdex.getViability('Shaymin-Sky', { usageRanks: new Map() });
    expect(shaymin.passes).toBe(false);
    expect(shaymin.score).toBe(0);

    const groudon = natdex.getViability('Groudon-Primal', { usageRanks: new Map() });
    expect(groudon.passes).toBe(true);
    expect(groudon.score).toBeGreaterThan(0);

    const unranked = natdex.getViability('Not A Real Species', { usageRanks: new Map() });
    expect(unranked.passes).toBe(false);
  });

  it('usageRankViability passes within the rank cutoff and fails outside it', () => {
    const ranks = new Map([['koraidon', 1], ['obscuremon', 999]]);
    const koraidon = ubers.getViability('Koraidon', { usageRanks: ranks });
    expect(koraidon.passes).toBe(true);
    const obscure = ubers.getViability('Obscuremon', { usageRanks: ranks });
    expect(obscure.passes).toBe(false);
    const untracked = ubers.getViability('NeverSeenMon', { usageRanks: ranks });
    expect(untracked.passes).toBe(false);
  });
});
