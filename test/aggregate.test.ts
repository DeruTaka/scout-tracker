import { describe, it, expect } from 'vitest';
import { Datastore } from '../src/store/datastore.js';
import { aggregateGroup, teamFingerprint } from '../src/ev/aggregate.js';
import type { MatchedSet, Replay, ScoutedReplay } from '../src/types.js';

function garchomp(overrides: Partial<MatchedSet> = {}): MatchedSet {
  return {
    species: 'Garchomp', baseSpecies: 'Garchomp', level: 100, shiny: false,
    moves: ['Earthquake'], revealedMoves: ['Earthquake'],
    item: undefined, itemRevealed: false, ability: undefined,
    nature: 'Jolly', evs: { hp: 4, atk: 252, spe: 252 },
    confidence: 0.4, notes: [], evSource: 'dex-set', choicePossible: true,
    ...overrides,
  };
}
function ferrothorn(): MatchedSet {
  return {
    species: 'Ferrothorn', baseSpecies: 'Ferrothorn', level: 100, shiny: false,
    moves: [], revealedMoves: [], item: undefined, itemRevealed: false, ability: undefined,
    nature: '', evs: {}, confidence: 0, notes: [], evSource: 'default', unrevealed: true,
  };
}
function toxapex(): MatchedSet {
  return {
    species: 'Toxapex', baseSpecies: 'Toxapex', level: 100, shiny: false,
    moves: [], revealedMoves: [], item: undefined, itemRevealed: false, ability: undefined,
    nature: 'Bold', evs: { hp: 252, def: 252, spd: 4 }, confidence: 0.5, notes: [], evSource: 'dex-set',
  };
}

function log(hpAfter: number): string {
  return [
    '|player|p1|Ash|', '|player|p2|Rival|', '|gen|9', '|tier|[Gen 9] OU',
    '|poke|p1|Garchomp|', '|poke|p1|Ferrothorn|', '|poke|p2|Toxapex|', '|poke|p2|Ferrothorn|',
    '|teampreview', '|start',
    '|switch|p1a: Garchomp|Garchomp|100/100',
    '|switch|p2a: Toxapex|Toxapex|100/100',
    '|turn|1',
    '|move|p1a: Garchomp|Earthquake|p2a: Toxapex',
    `|-damage|p2a: Toxapex|${hpAfter}/100`,
    '|turn|2',
  ].join('\n');
}

function scouted(id: string, hpAfter: number, garchompOverrides: Partial<MatchedSet> = {}): ScoutedReplay {
  const replay: Replay = {
    id, url: `https://replay.pokemonshowdown.com/${id}`, format: '[Gen 9] OU', formatid: 'gen9ou',
    gen: 9, players: ['Ash', 'Rival'], log: log(hpAfter), uploadtime: 1700000000,
  };
  const gc = garchomp(garchompOverrides);
  const fe = ferrothorn();
  const tp = toxapex();
  return {
    replay, scoutedAt: Date.now(),
    teams: [
      { player: 'Ash', side: 'p1', sets: [gc, fe], paste: 'placeholder' },
      { player: 'Rival', side: 'p2', sets: [tp, ferrothorn()], paste: 'placeholder' },
    ],
  };
}

describe('cross-replay aggregation', () => {
  it('pools damage evidence and writes an identical result to every member replay', () => {
    const store = new Datastore('/nonexistent/aggregate-test-store.json');
    const a = scouted('replayA', 55); // 45% dealt
    const b = scouted('replayB', 62); // 38% dealt
    store.ingest(a);
    store.ingest(b);

    const fp = teamFingerprint(a.teams[0]!.sets);
    expect(fp).toBe(teamFingerprint(b.teams[0]!.sets)); // same roster -> same fingerprint

    const result = aggregateGroup(store, 'ash', 'gen9ou', fp);
    expect(result.replaysUpdated).toBe(2);

    const gcA = store.replays.find((r) => r.id === 'replayA')!.teams[0]!.sets.find((s) => s.baseSpecies === 'Garchomp')!;
    const gcB = store.replays.find((r) => r.id === 'replayB')!.teams[0]!.sets.find((s) => s.baseSpecies === 'Garchomp')!;

    // Both replays converge to the identical pooled spread.
    expect(gcA.evs).toEqual(gcB.evs);
    expect(gcA.nature).toBe(gcB.nature);
    expect(gcA.confidence).toBe(gcB.confidence);
    expect(gcA.notes.some((n) => n.startsWith('Pooled across 2 replays'))).toBe(true);
    expect(gcB.notes.some((n) => n.startsWith('Pooled across 2 replays'))).toBe(true);

    // Pastes were regenerated to reflect the pooled spread.
    expect(store.replays.find((r) => r.id === 'replayA')!.teams[0]!.paste).not.toBe('placeholder');
  });

  it('never overwrites a directly-revealed item, but propagates it to the other replay', () => {
    const store = new Datastore('/nonexistent/aggregate-test-store.json');
    // Replay A: item genuinely shown in-game. Replay B: item never revealed.
    store.ingest(scouted('replayA', 55, { item: 'Life Orb', itemRevealed: true }));
    store.ingest(scouted('replayB', 62));

    const fp = teamFingerprint(scouted('x', 0).teams[0]!.sets);
    aggregateGroup(store, 'ash', 'gen9ou', fp);

    const gcA = store.replays.find((r) => r.id === 'replayA')!.teams[0]!.sets.find((s) => s.baseSpecies === 'Garchomp')!;
    const gcB = store.replays.find((r) => r.id === 'replayB')!.teams[0]!.sets.find((s) => s.baseSpecies === 'Garchomp')!;

    expect(gcA.item).toBe('Life Orb');
    expect(gcA.itemRevealed).toBe(true); // ground truth for THIS replay, never touched
    expect(gcB.item).toBe('Life Orb'); // propagated from the confirmed replay
  });

  it('leaves an unrevealed mon (Ferrothorn) completely untouched', () => {
    const store = new Datastore('/nonexistent/aggregate-test-store.json');
    store.ingest(scouted('replayA', 55));
    store.ingest(scouted('replayB', 62));
    const fp = teamFingerprint(scouted('x', 0).teams[0]!.sets);
    aggregateGroup(store, 'ash', 'gen9ou', fp);

    const feA = store.replays.find((r) => r.id === 'replayA')!.teams[0]!.sets.find((s) => s.baseSpecies === 'Ferrothorn')!;
    expect(feA.notes).toEqual([]);
    expect(feA.unrevealed).toBe(true);
  });

  it('is idempotent — re-running aggregation does not pile up duplicate notes', () => {
    const store = new Datastore('/nonexistent/aggregate-test-store.json');
    store.ingest(scouted('replayA', 55));
    store.ingest(scouted('replayB', 62));
    const fp = teamFingerprint(scouted('x', 0).teams[0]!.sets);

    aggregateGroup(store, 'ash', 'gen9ou', fp);
    const firstLen = store.replays.find((r) => r.id === 'replayA')!.teams[0]!.sets[0]!.notes.length;
    aggregateGroup(store, 'ash', 'gen9ou', fp);
    aggregateGroup(store, 'ash', 'gen9ou', fp);
    const laterLen = store.replays.find((r) => r.id === 'replayA')!.teams[0]!.sets[0]!.notes.length;

    expect(laterLen).toBe(firstLen);
  });

  it('does nothing for a single replay (nothing to pool yet)', () => {
    const store = new Datastore('/nonexistent/aggregate-test-store.json');
    const a = scouted('replayA', 55);
    store.ingest(a);
    const fp = teamFingerprint(a.teams[0]!.sets);
    const result = aggregateGroup(store, 'ash', 'gen9ou', fp);
    expect(result.replaysUpdated).toBe(0);
  });
});
