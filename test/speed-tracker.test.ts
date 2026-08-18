import { describe, it, expect } from 'vitest';
import { extractSpeedObservations } from '../src/ev/speed-tracker.js';
import type { Replay } from '../src/types.js';

function replay(log: string): Replay {
  return {
    id: 'test', url: '', format: '[Gen 9] Ubers', formatid: 'gen9ubers', gen: 9,
    players: ['A', 'B'], log, uploadtime: 0,
  };
}

describe('a status move from a Prankster-capable mon is not treated as Speed evidence', () => {
  it('excludes the turn (Thunder Wave could have gone first on priority alone, not Speed)', () => {
    const log = [
      '|switch|p1a: Gouging Fire|Gouging Fire|100/100',
      '|switch|p2a: Grimmsnarl|Grimmsnarl, M|100/100',
      '|turn|1',
      '|move|p2a: Grimmsnarl|Thunder Wave|p1a: Gouging Fire',
      '|-status|p1a: Gouging Fire|par',
      '|move|p1a: Gouging Fire|Dragon Dance|p1a: Gouging Fire',
      '|-boost|p1a: Gouging Fire|atk|1',
      '|turn|2',
    ].join('\n');
    const obs = extractSpeedObservations(replay(log));
    expect(obs.length).toBe(0);
  });

  it('does NOT exclude a turn where neither mon could have a priority-bending ability for the moves used', () => {
    const log = [
      '|switch|p1a: Gouging Fire|Gouging Fire|100/100',
      '|switch|p2a: Mewtwo|Mewtwo|100/100',
      '|turn|1',
      '|move|p2a: Mewtwo|Nasty Plot|p2a: Mewtwo',
      '|-boost|p2a: Mewtwo|spa|2',
      '|move|p1a: Gouging Fire|Outrage|p2a: Mewtwo',
      '|-damage|p2a: Mewtwo|73/100',
      '|turn|2',
    ].join('\n');
    const obs = extractSpeedObservations(replay(log));
    expect(obs.length).toBe(1);
    expect(obs[0]!.fasterSpecies).toBe('Mewtwo');
    expect(obs[0]!.slowerSpecies).toBe('Gouging Fire');
  });
});

describe('status persists across a switch (re-entering already paralyzed etc.)', () => {
  it('carries the status shown in the switch line forward, without a fresh |-status|', () => {
    const log = [
      '|switch|p1a: Gouging Fire|Gouging Fire|100/100',
      '|switch|p2a: Grimmsnarl|Grimmsnarl, M|100/100',
      '|turn|1',
      '|move|p2a: Grimmsnarl|Thunder Wave|p1a: Gouging Fire',
      '|-status|p1a: Gouging Fire|par',
      '|cant|p1a: Gouging Fire|par',
      '|turn|2',
      '|switch|p1a: Gouging Fire|Gouging Fire|100/100 par',
      '|switch|p2a: Mewtwo|Mewtwo|100/100',
      '|turn|3',
      '|move|p2a: Mewtwo|Nasty Plot|p2a: Mewtwo',
      '|-boost|p2a: Mewtwo|spa|2',
      '|move|p1a: Gouging Fire|Outrage|p2a: Mewtwo',
      '|-damage|p2a: Mewtwo|73/100',
      '|turn|4',
    ].join('\n');
    const obs = extractSpeedObservations(replay(log));
    const o = obs.find((x) => x.turn === 3);
    expect(o).toBeTruthy();
    expect(o!.slowerSpecies).toBe('Gouging Fire');
    expect(o!.slowerStatus).toBe('par');
  });
});
