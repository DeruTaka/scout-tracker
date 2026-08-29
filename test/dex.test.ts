import { describe, it, expect } from 'vitest';
import { getGen, speciesMeta } from '../src/data/dex.js';

describe('speciesMeta', () => {
  const gen = getGen(9);

  it('resolves species the gen9 regional dex carries directly', () => {
    const meta = speciesMeta(gen, 'Koraidon');
    expect(meta).toMatchObject({ baseSpecies: 'Koraidon', forme: '' });
    expect(gen.species.get('Koraidon')).toBeDefined(); // sanity: this one IS in the regional dex
  });

  it('falls back to the ungenned base dex for National-Dex-only species gen9 excludes', () => {
    // gen.species.get() alone returns undefined for these — they're real
    // National Dex Ubers staples, just not part of the SV regional dex.
    expect(gen.species.get('Marshadow')).toBeUndefined();
    expect(gen.species.get('Groudon-Primal')).toBeUndefined();
    expect(gen.species.get('Ferrothorn')).toBeUndefined();

    const marshadow = speciesMeta(gen, 'Marshadow');
    expect(marshadow).toBeDefined();
    expect(marshadow!.types.map((t) => t.toLowerCase())).toEqual(expect.arrayContaining(['fighting', 'ghost']));

    const groudonPrimal = speciesMeta(gen, 'Groudon-Primal');
    expect(groudonPrimal).toBeDefined();
    expect(groudonPrimal!.types.map((t) => t.toLowerCase())).toEqual(expect.arrayContaining(['ground', 'fire']));
    expect(groudonPrimal!.baseSpecies).toBe('Groudon');
  });

  it('returns undefined for a name that resolves nowhere', () => {
    expect(speciesMeta(gen, 'Not A Real Species')).toBeUndefined();
  });
});
