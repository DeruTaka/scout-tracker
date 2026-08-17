import { describe, it, expect } from 'vitest';
import { extractObservations } from '../src/ev/field-tracker.js';
import type { Replay } from '../src/types.js';

function replay(log: string): Replay {
  return {
    id: 'test', url: '', format: '[Gen 9] Ubers', formatid: 'gen9ubers', gen: 9,
    players: ['A', 'B'], log, uploadtime: 0,
  };
}

describe('Focus Sash / Sturdy / Endure saves are excluded from usable damage evidence', () => {
  it('marks a Focus-Sash-clipped hit unusable (observed % misrepresents true damage)', () => {
    const log = [
      '|switch|p1a: Glimmora|Glimmora, F|100/100',
      '|switch|p2a: Zacian|Zacian-Crowned|100/100',
      '|turn|1',
      '|move|p2a: Zacian|Behemoth Blade|p1a: Glimmora',
      '|-supereffective|p1a: Glimmora',
      '|-enditem|p1a: Glimmora|Focus Sash',
      '|-damage|p1a: Glimmora|1/100',
      '|turn|2',
    ].join('\n');
    const obs = extractObservations(replay(log));
    const hit = obs.find((o) => o.move === 'Behemoth Blade');
    expect(hit).toBeTruthy();
    expect(hit!.usable).toBe(false);
    expect(hit!.reason).toContain('focus sash');
  });

  it('marks a Sturdy-endured hit unusable', () => {
    const log = [
      '|switch|p1a: Skarmory|Skarmory, F|100/100',
      '|switch|p2a: Zacian|Zacian-Crowned|100/100',
      '|turn|1',
      '|move|p2a: Zacian|Behemoth Blade|p1a: Skarmory',
      '|-activate|p1a: Skarmory|ability: Sturdy',
      '|-damage|p1a: Skarmory|1/100',
      '|turn|2',
    ].join('\n');
    const obs = extractObservations(replay(log));
    const hit = obs.find((o) => o.move === 'Behemoth Blade');
    expect(hit!.usable).toBe(false);
    expect(hit!.reason).toContain('sturdy');
  });

  it('marks an Endure-survived hit unusable', () => {
    const log = [
      '|switch|p1a: Ho-Oh|Ho-Oh|100/100',
      '|switch|p2a: Zacian|Zacian-Crowned|100/100',
      '|turn|1',
      '|move|p1a: Ho-Oh|Endure|p1a: Ho-Oh',
      '|-singleturn|p1a: Ho-Oh|move: Endure',
      '|move|p2a: Zacian|Behemoth Blade|p1a: Ho-Oh',
      '|-activate|p1a: Ho-Oh|move: Endure',
      '|-damage|p1a: Ho-Oh|1/100',
      '|turn|2',
    ].join('\n');
    const obs = extractObservations(replay(log));
    const hit = obs.find((o) => o.move === 'Behemoth Blade');
    expect(hit!.usable).toBe(false);
    expect(hit!.reason).toContain('endure');
  });

  it('a normal hit (no save) stays usable', () => {
    const log = [
      '|switch|p1a: Glimmora|Glimmora, F|100/100',
      '|switch|p2a: Zacian|Zacian-Crowned|100/100',
      '|turn|1',
      '|move|p2a: Zacian|Behemoth Blade|p1a: Glimmora',
      '|-supereffective|p1a: Glimmora',
      '|-damage|p1a: Glimmora|30/100',
      '|turn|2',
    ].join('\n');
    const obs = extractObservations(replay(log));
    const hit = obs.find((o) => o.move === 'Behemoth Blade');
    expect(hit!.usable).toBe(true);
    expect(hit!.observedPercent).toBeCloseTo(70, 5);
  });
});
