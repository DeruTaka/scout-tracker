import { describe, it, expect } from 'vitest';
import { Datastore } from '../src/store/datastore.js';
import type { MatchedSet, ScoutedReplay } from '../src/types.js';

function freshStore(): Datastore {
  // A path that doesn't exist starts the store empty in-memory; tests never
  // call .save(), so nothing touches disk.
  return new Datastore(`/tmp/does-not-exist-${Math.random()}.json`);
}

function zacianPin(): MatchedSet {
  return {
    species: 'Zacian-Crowned', baseSpecies: 'Zacian-Crowned', level: 100, shiny: false,
    moves: ['Swords Dance', 'Behemoth Blade', 'Close Combat', 'Wild Charge'],
    revealedMoves: ['Swords Dance', 'Behemoth Blade', 'Close Combat', 'Wild Charge'],
    item: 'Rusted Sword', itemRevealed: true, ability: 'Intrepid Sword',
    nature: 'Jolly', evs: { hp: 208, atk: 108, spe: 192 }, tera: 'Electric',
    confidence: 1, notes: [], evSource: 'derived', choicePossible: true,
  };
}

describe('Datastore pins', () => {
  it('stores and lists a pin', () => {
    const store = freshStore();
    store.addPin('Taka', 'gen9ubers', zacianPin(), 'confirmed by trainer');
    const pins = store.listPins('Taka');
    expect(pins.length).toBe(1);
    expect(pins[0]!.set.species).toBe('Zacian-Crowned');
    expect(pins[0]!.note).toBe('confirmed by trainer');
  });

  it('replaces an existing pin for the same player/format/species rather than duplicating', () => {
    const store = freshStore();
    store.addPin('Taka', 'gen9ubers', zacianPin());
    store.addPin('Taka', 'gen9ubers', { ...zacianPin(), evs: { hp: 252, atk: 4, spe: 252 } });
    const pins = store.listPins('Taka');
    expect(pins.length).toBe(1);
    expect(pins[0]!.set.evs).toEqual({ hp: 252, atk: 4, spe: 252 });
  });

  it('removes a pin', () => {
    const store = freshStore();
    store.addPin('Taka', 'gen9ubers', zacianPin());
    expect(store.removePin('Taka', 'gen9ubers', 'Zacian-Crowned')).toBe(true);
    expect(store.listPins('Taka').length).toBe(0);
    expect(store.removePin('Taka', 'gen9ubers', 'Zacian-Crowned')).toBe(false); // already gone
  });

  it('getPriorSets returns the pin first, marked verified, ahead of scouted history', () => {
    const store = freshStore();
    store.addPin('Taka', 'gen9ubers', zacianPin());
    const priors = store.getPriorSets('Taka', 'gen9ubers', 'Zacian-Crowned');
    expect(priors.length).toBeGreaterThan(0);
    expect(priors[0]!.verified).toBe(true);
    expect(priors[0]!.evs).toEqual({ hp: 208, atk: 108, spe: 192 });
    expect(priors[0]!.role).toContain('Pinned');
  });

  it('is scoped to the exact player + formatid + species', () => {
    const store = freshStore();
    store.addPin('Taka', 'gen9ubers', zacianPin());
    expect(store.getPriorSets('SomeoneElse', 'gen9ubers', 'Zacian-Crowned').length).toBe(0);
    expect(store.getPriorSets('Taka', 'gen9ou', 'Zacian-Crowned').length).toBe(0);
    expect(store.getPriorSets('Taka', 'gen9ubers', 'Koraidon').length).toBe(0);
  });

  it('survives rebuildUniqueSets (lives outside the replay-derived uniqueSets table)', () => {
    const store = freshStore();
    store.addPin('Taka', 'gen9ubers', zacianPin());
    const fakeReplay: ScoutedReplay = {
      replay: {
        id: 'fake-1', url: '', format: '[Gen 9] Ubers', formatid: 'gen9ubers', gen: 9,
        players: ['Taka', 'Opponent'], log: '', uploadtime: 1700000000,
      },
      teams: [{ player: 'Taka', side: 'p1', sets: [], paste: '' }],
      scoutedAt: Date.now(),
    };
    store.ingest(fakeReplay);
    store.rebuildUniqueSets();
    expect(store.listPins('Taka').length).toBe(1);
    expect(store.getPriorSets('Taka', 'gen9ubers', 'Zacian-Crowned')[0]!.verified).toBe(true);
  });
});
