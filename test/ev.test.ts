import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseReplay } from '../src/replay/parse.js';
import { extractObservations } from '../src/ev/field-tracker.js';
import { deriveEvs, deriveSpeed, type SideSets } from '../src/ev/engine.js';
import { matchSet } from '../src/match/match-set.js';
import { getSetsForSpecies } from '../src/data/sets-provider.js';
import { genFromFormatId, getGen } from '../src/data/dex.js';
import type { DamageObservation, MatchedSet, Replay, SpeedObservation } from '../src/types.js';

function loadFixture(name: string): Replay {
  const path = fileURLToPath(new URL(`./fixtures/${name}.json`, import.meta.url));
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  return {
    id: raw.id, url: '', format: raw.format, formatid: raw.formatid,
    gen: genFromFormatId(raw.formatid), players: raw.players, log: raw.log, uploadtime: raw.uploadtime,
  };
}

describe('EV engine on smogtours-gen8uu-963226', () => {
  const replay = loadFixture('smogtours-gen8uu-963226');
  const gen = getGen(replay.gen);
  const teams = parseReplay(replay);

  it('extracts usable damage observations', () => {
    const obs = extractObservations(replay);
    expect(obs.length).toBeGreaterThan(20);
    expect(obs.filter((o) => o.usable).length).toBeGreaterThan(15);
    // A concrete non-KO hit: Nidoqueen Earth Power vs Seismitoad early on.
    const ep = obs.find(
      (o) => o.move === 'Earth Power' && o.defenderSpecies === 'Seismitoad' && o.usable,
    );
    expect(ep).toBeTruthy();
    expect(ep!.observedPercent).toBeGreaterThan(20);
  });

  it('derives spreads without collapsing offensive EVs on KO hits', async () => {
    const sideSets: SideSets[] = [];
    for (const t of teams) {
      const sets: MatchedSet[] = [];
      for (const m of t.mons) sets.push(matchSet(gen, m, await getSetsForSpecies(replay.formatid, m.baseSpecies)));
      sideSets.push({ side: t.side, sets });
    }
    deriveEvs(replay.gen, sideSets, extractObservations(replay));

    const find = (side: 'p1' | 'p2', sp: string) =>
      sideSets.find((s) => s.side === side)!.sets.find((x) => x.baseSpecies === sp)!;

    // Nidoqueen is a special attacker in this game; SpA must stay substantial
    // (the OHKO on Noivern must NOT drag it to 0).
    const nido = find('p1', 'Nidoqueen');
    expect((nido.evs.spa ?? 0)).toBeGreaterThan(150);

    // Registeel's physical damage (Earthquake) fits its dex spread -> corroborated,
    // spread left as the dex set.
    const registeel = find('p1', 'Registeel');
    expect(registeel.evSource).toBe('dex-set');
  });
});

describe('EV engine infers Choice Specs from damage (smogtours-gen9ubers-952059)', () => {
  const replay = loadFixture('smogtours-gen9ubers-952059');
  const gen = getGen(replay.gen);
  const teams = parseReplay(replay);

  it('reads Fc ❤ Kyogre as a Choice Specs attacker, not a defensive Air Balloon set', async () => {
    const sideSets: SideSets[] = [];
    for (const t of teams) {
      const sets: MatchedSet[] = [];
      for (const m of t.mons) sets.push(matchSet(gen, m, await getSetsForSpecies(replay.formatid, m.baseSpecies)));
      sideSets.push({ side: t.side, sets });
    }
    deriveEvs(replay.gen, sideSets, extractObservations(replay));

    const kyogre = sideSets.find((s) => s.side === 'p2')!.sets.find((x) => x.baseSpecies === 'Kyogre')!;
    // The 100% KO on Koraidon is only reachable with a Choice item; Life Orb /
    // Air Balloon would have revealed themselves, so Choice Specs is the read.
    expect(kyogre.item).toBe('Choice Specs');
    expect(kyogre.itemRevealed).toBe(false);
    expect(kyogre.evSource).toBe('derived');
  });
});

describe('defense EV search trades Speed for bulk when the prior is already maxed', () => {
  // Reproduces smogtours-gen9ubers-956423 turn 14: 252 Atk Tera Fire Koraidon
  // Flame Charge predicts 55.3-65.2% against a 0 HP / 0 Def Zacian-Crowned (the
  // prior, which already spends the full 508 EVs offensively) but only 52% was
  // observed. That's below even the worst roll, so it can't be variance.
  function zacian(): MatchedSet {
    return {
      species: 'Zacian-Crowned', baseSpecies: 'Zacian-Crowned', level: 100, shiny: false,
      moves: ['Behemoth Blade'], revealedMoves: ['Behemoth Blade'],
      item: 'Rusted Sword', itemRevealed: true, ability: 'Intrepid Sword',
      nature: 'Jolly', evs: { atk: 252, spd: 4, spe: 252 },
      confidence: 0.7, notes: [], evSource: 'dex-set', choicePossible: true,
    };
  }
  function koraidon(): MatchedSet {
    return {
      species: 'Koraidon', baseSpecies: 'Koraidon', level: 100, shiny: false,
      moves: ['Flame Charge'], revealedMoves: ['Flame Charge'],
      item: undefined, itemRevealed: false, ability: 'Orichalcum Pulse',
      nature: 'Jolly', evs: { atk: 252, def: 4, spe: 252 },
      confidence: 0.6, notes: [], evSource: 'dex-set', choicePossible: true, tera: 'Fire',
    };
  }
  function hit(): DamageObservation {
    return {
      turn: 14, attackerSide: 'p1', attackerSpecies: 'Koraidon', defenderSide: 'p2',
      defenderSpecies: 'Zacian-Crowned', move: 'Flame Charge', observedPercent: 52,
      koCapped: false, field: {
        attackerBoosts: {}, defenderBoosts: {}, reflect: false, lightScreen: false,
        auroraVeil: false, attackerHpPercent: 76, defenderHpPercent: 94, attackerTera: 'Fire',
      }, crit: false, usable: true,
    };
  }

  it('stays conservative on a single ambiguous hit (avoids overfitting one data point)', () => {
    const zac = zacian();
    const teams: SideSets[] = [{ side: 'p1', sets: [koraidon()] }, { side: 'p2', sets: [zac] }];
    deriveEvs(9, teams, [hit()]);
    expect(zac.evs).toEqual({ atk: 252, spd: 4, spe: 252 });
  });

  it('derives the Speed-for-bulk trade once 2+ consistent hits confirm it', () => {
    const zac = zacian();
    const teams: SideSets[] = [{ side: 'p1', sets: [koraidon()] }, { side: 'p2', sets: [zac] }];
    deriveEvs(9, teams, [hit(), hit()]);
    expect(zac.evs.def).toBeGreaterThan(0);
    expect(zac.evs.spe).toBeLessThan(252); // paid for by donors, not free EVs
    // Budget conserved: the Def gain came from other stats shrinking, not from nowhere.
    const total = (['hp', 'atk', 'def', 'spa', 'spd', 'spe'] as const).reduce((s, k) => s + (zac.evs[k] ?? 0), 0);
    expect(total).toBe(508);
    expect(zac.notes.some((n) => n.includes('Traded'))).toBe(true);
  });
});

describe('offense EV search donates from any unused stat, not just a hardcoded one', () => {
  // A Koraidon dex-matched as a pure defensive wall (0 Atk investment) — but if
  // it hits hard enough that no plain 0-Atk spread explains the damage, the
  // generalized donor search must find room for real Atk investment by
  // shrinking whatever it invested least in (here: SpD/Spe before HP/Def).
  function wallKoraidon(): MatchedSet {
    return {
      species: 'Koraidon', baseSpecies: 'Koraidon', level: 100, shiny: false,
      moves: ['Flame Charge'], revealedMoves: ['Flame Charge'],
      item: undefined, itemRevealed: false, ability: 'Orichalcum Pulse',
      nature: 'Impish', evs: { hp: 252, def: 252, spe: 4 },
      confidence: 0.6, notes: [], evSource: 'dex-set', choicePossible: true, tera: 'Fire',
    };
  }
  function fixedZacian(): MatchedSet {
    return {
      species: 'Zacian-Crowned', baseSpecies: 'Zacian-Crowned', level: 100, shiny: false,
      moves: ['Behemoth Blade'], revealedMoves: ['Behemoth Blade'],
      item: 'Rusted Sword', itemRevealed: true, ability: 'Intrepid Sword',
      nature: 'Jolly', evs: { hp: 252, spd: 4, spe: 252 },
      confidence: 0.7, notes: [], evSource: 'dex-set', choicePossible: true,
    };
  }
  function bigHit(): DamageObservation {
    return {
      turn: 3, attackerSide: 'p1', attackerSpecies: 'Koraidon', defenderSide: 'p2',
      defenderSpecies: 'Zacian-Crowned', move: 'Flame Charge', observedPercent: 80,
      koCapped: false, field: {
        attackerBoosts: {}, defenderBoosts: {}, reflect: false, lightScreen: false,
        auroraVeil: false, attackerHpPercent: 100, defenderHpPercent: 100, attackerTera: 'Fire',
      }, crit: false, usable: true,
    };
  }

  it('funds Atk investment from other stats when the 0-Atk prior cannot explain the damage', () => {
    const kora = wallKoraidon();
    const teams: SideSets[] = [{ side: 'p1', sets: [kora] }, { side: 'p2', sets: [fixedZacian()] }];
    deriveEvs(9, teams, [bigHit(), bigHit()]);
    expect(kora.evs.atk).toBeGreaterThan(0);
    const total = (['hp', 'atk', 'def', 'spa', 'spd', 'spe'] as const).reduce((s, k) => s + (kora.evs[k] ?? 0), 0);
    expect(total).toBe(508);
    expect(kora.notes.some((n) => n.includes('Traded'))).toBe(true);
  });
});

describe('speed EV search donates from other stats when a maxed non-Speed prior blocks the derived floor', () => {
  // A Koraidon dex-matched as bulky/support (0 Speed investment, budget already
  // spent on HP/SpD) that turn order proves is faster than a max-Speed Zacian.
  // The old refineSpeed had no donor logic at all here — it would hit the
  // budget wall and silently keep the (contradicted) 0-Speed prior.
  function slowKoraidon(): MatchedSet {
    return {
      species: 'Koraidon', baseSpecies: 'Koraidon', level: 100, shiny: false,
      moves: ['Flame Charge'], revealedMoves: ['Flame Charge'],
      item: 'Leftovers', itemRevealed: true, ability: 'Orichalcum Pulse',
      nature: 'Impish', evs: { hp: 252, spd: 252, atk: 4 },
      confidence: 0.6, notes: [], evSource: 'dex-set', choicePossible: true, tera: 'Fire',
    };
  }
  // Neutral nature + maxed Speed puts Zacian's effective Speed (395) just
  // under Koraidon's absolute ceiling (405, Jolly + 252 EVs) but well above
  // Koraidon's 0-investment floor (336 w/ Jolly) — so beating it is possible,
  // but only with real EV investment, not a free nature swap alone.
  function fastZacian(): MatchedSet {
    return {
      species: 'Zacian-Crowned', baseSpecies: 'Zacian-Crowned', level: 100, shiny: false,
      moves: ['Behemoth Blade'], revealedMoves: ['Behemoth Blade'],
      item: 'Rusted Sword', itemRevealed: true, ability: 'Intrepid Sword',
      nature: 'Bashful', evs: { spe: 252 },
      confidence: 0.7, notes: [], evSource: 'dex-set', choicePossible: true,
    };
  }
  function speedObs(): SpeedObservation {
    return {
      turn: 1, fasterSide: 'p1', fasterSpecies: 'Koraidon', slowerSide: 'p2', slowerSpecies: 'Zacian-Crowned',
      fasterBoosts: {}, slowerBoosts: {}, trickRoom: false,
    };
  }

  it('funds Speed investment from other stats when the 0-Speed prior cannot explain being faster', () => {
    const kora = slowKoraidon();
    const teams: SideSets[] = [{ side: 'p1', sets: [kora] }, { side: 'p2', sets: [fastZacian()] }];
    deriveSpeed(9, teams, [speedObs()]);
    expect(kora.evs.spe).toBeGreaterThan(0);
    const total = (['hp', 'atk', 'def', 'spa', 'spd', 'spe'] as const).reduce((s, k) => s + (kora.evs[k] ?? 0), 0);
    expect(total).toBe(508);
    expect(kora.notes.some((n) => n.includes('Traded'))).toBe(true);
    expect(kora.speedFloor).toBeGreaterThan(0);
  });
});

describe('a derived-down offense stat frees EVs into HP instead of leaving them unspent', () => {
  // Weak, repeated Behemoth Blade hits force Zacian's Atk down from a maxed
  // 252/4/252 prior — a plain decrease, not a donor trade — so nothing else
  // automatically fills the freed budget. A real spread wouldn't just leave
  // 248 EVs unspent; they should land in HP by default.
  function zacian(): MatchedSet {
    return {
      species: 'Zacian-Crowned', baseSpecies: 'Zacian-Crowned', level: 100, shiny: false,
      moves: ['Behemoth Blade'], revealedMoves: ['Behemoth Blade'],
      item: 'Rusted Sword', itemRevealed: true, ability: 'Intrepid Sword',
      nature: 'Jolly', evs: { atk: 252, spd: 4, spe: 252 },
      confidence: 0.7, notes: [], evSource: 'dex-set', choicePossible: true,
    };
  }
  function fodder(): MatchedSet {
    return {
      species: 'Blissey', baseSpecies: 'Blissey', level: 100, shiny: false,
      moves: ['Seismic Toss'], revealedMoves: ['Seismic Toss'],
      item: 'Leftovers', itemRevealed: true, ability: 'Natural Cure',
      nature: 'Calm', evs: { hp: 252, spd: 252, spe: 4 },
      confidence: 0.7, notes: [], evSource: 'dex-set', choicePossible: true,
    };
  }
  function weakHit(): DamageObservation {
    return {
      turn: 5, attackerSide: 'p1', attackerSpecies: 'Zacian-Crowned', defenderSide: 'p2',
      defenderSpecies: 'Blissey', move: 'Behemoth Blade', observedPercent: 5,
      koCapped: false, field: {
        attackerBoosts: {}, defenderBoosts: {}, reflect: false, lightScreen: false,
        auroraVeil: false, attackerHpPercent: 100, defenderHpPercent: 100,
      }, crit: false, usable: true,
    };
  }

  it('tops HP up to a full 508-EV spread when the freed stat has no other claim', () => {
    const zac = zacian();
    const teams: SideSets[] = [{ side: 'p1', sets: [zac] }, { side: 'p2', sets: [fodder()] }];
    deriveEvs(9, teams, [weakHit(), weakHit()]);
    expect(zac.evs.atk).toBeLessThan(252);
    const total = (['hp', 'atk', 'def', 'spa', 'spd', 'spe'] as const).reduce((s, k) => s + (zac.evs[k] ?? 0), 0);
    expect(total).toBe(508);
    expect(zac.evs.hp).toBeGreaterThan(0);
    expect(zac.notes.some((n) => n.includes('Filled') && n.includes('HP'))).toBe(true);
  });

  it('does NOT re-touch HP/Def once evidenced, but DOES fill the untested SpD (only physical hits observed)', () => {
    const zac = zacian();
    const kora: MatchedSet = {
      species: 'Koraidon', baseSpecies: 'Koraidon', level: 100, shiny: false,
      moves: ['Flame Charge'], revealedMoves: ['Flame Charge'],
      item: undefined, itemRevealed: false, ability: 'Orichalcum Pulse',
      nature: 'Jolly', evs: { atk: 4, def: 252, spe: 252 },
      confidence: 0.6, notes: [], evSource: 'dex-set', choicePossible: true, tera: 'Fire',
    };
    const hitOnKoraidon = (): DamageObservation => ({
      turn: 5, attackerSide: 'p1', attackerSpecies: 'Zacian-Crowned', defenderSide: 'p2',
      defenderSpecies: 'Koraidon', move: 'Behemoth Blade', observedPercent: 90,
      koCapped: false, field: {
        attackerBoosts: {}, defenderBoosts: {}, reflect: false, lightScreen: false,
        auroraVeil: false, attackerHpPercent: 100, defenderHpPercent: 100,
      }, crit: false, usable: true,
    });
    const teams: SideSets[] = [{ side: 'p1', sets: [zac] }, { side: 'p2', sets: [kora] }];
    deriveEvs(9, teams, [hitOnKoraidon(), hitOnKoraidon()]);
    // HP/Def came straight out of the defense-evidence search (0/36 for this
    // exact scenario) — Pass C must not perturb them, even though it's free
    // to top up the untested SpD.
    expect(kora.notes.some((n) => n.includes('Derived HP/DEF'))).toBe(true);
    const total = (['hp', 'atk', 'def', 'spa', 'spd', 'spe'] as const).reduce((s, k) => s + (kora.evs[k] ?? 0), 0);
    expect(total).toBe(508);
    expect(kora.evs.hp).toBe(0);
    expect(kora.evs.def).toBe(36);
    expect(kora.evs.spd).toBeGreaterThan(0);
    expect(kora.notes.some((n) => n.includes('Filled') && n.includes('SpD'))).toBe(true);
  });
});

describe('leftover-EV fill prefers a trainer-history reference over a blind HP max', () => {
  function zacian(): MatchedSet {
    return {
      species: 'Zacian-Crowned', baseSpecies: 'Zacian-Crowned', level: 100, shiny: false,
      moves: ['Behemoth Blade'], revealedMoves: ['Behemoth Blade'],
      item: 'Rusted Sword', itemRevealed: true, ability: 'Intrepid Sword',
      nature: 'Jolly', evs: { atk: 252, spd: 4, spe: 252 },
      confidence: 0.7, notes: [], evSource: 'dex-set', choicePossible: true,
    };
  }
  function fodder(): MatchedSet {
    return {
      species: 'Blissey', baseSpecies: 'Blissey', level: 100, shiny: false,
      moves: ['Seismic Toss'], revealedMoves: ['Seismic Toss'],
      item: 'Leftovers', itemRevealed: true, ability: 'Natural Cure',
      nature: 'Calm', evs: { hp: 252, spd: 252, spe: 4 },
      confidence: 0.7, notes: [], evSource: 'dex-set', choicePossible: true,
    };
  }
  function weakHit(): DamageObservation {
    return {
      turn: 5, attackerSide: 'p1', attackerSpecies: 'Zacian-Crowned', defenderSide: 'p2',
      defenderSpecies: 'Blissey', move: 'Behemoth Blade', observedPercent: 5,
      koCapped: false, field: {
        attackerBoosts: {}, defenderBoosts: {}, reflect: false, lightScreen: false,
        auroraVeil: false, attackerHpPercent: 100, defenderHpPercent: 100,
      }, crit: false, usable: true,
    };
  }

  it("uses this trainer's other build of the species instead of maxing HP blind", () => {
    const zac = zacian();
    const teams: SideSets[] = [{ side: 'p1', sets: [zac] }, { side: 'p2', sets: [fodder()] }];
    // This trainer's other Zacian-Crowned games show a bulky-Def build, not a
    // pure-HP dump — a smarter fill should reflect that instead of always HP.
    deriveEvs(9, teams, [weakHit(), weakHit()], {
      referenceEvs: (side, baseSpecies) =>
        side === 'p1' && baseSpecies === 'Zacian-Crowned' ? { hp: 100, def: 148 } : undefined,
    });
    expect(zac.evs.atk).toBeLessThan(252);
    expect(zac.evs.hp).toBe(100);
    expect(zac.evs.def).toBe(148);
    const total = (['hp', 'atk', 'def', 'spa', 'spd', 'spe'] as const).reduce((s, k) => s + (zac.evs[k] ?? 0), 0);
    expect(total).toBe(508);
    expect(zac.notes.some((n) => n.includes('Filled') && n.includes("trainer's other"))).toBe(true);
  });

  it('still tops up with a blind HP max for whatever the reference leaves short', () => {
    const zac = zacian();
    const teams: SideSets[] = [{ side: 'p1', sets: [zac] }, { side: 'p2', sets: [fodder()] }];
    // Reference only accounts for a small slice of the freed budget — the rest
    // must still land somewhere so the spread stays a complete 508.
    deriveEvs(9, teams, [weakHit(), weakHit()], {
      referenceEvs: (side, baseSpecies) => (side === 'p1' && baseSpecies === 'Zacian-Crowned' ? { hp: 20 } : undefined),
    });
    const total = (['hp', 'atk', 'def', 'spa', 'spd', 'spe'] as const).reduce((s, k) => s + (zac.evs[k] ?? 0), 0);
    expect(total).toBe(508);
    expect(zac.evs.hp).toBeGreaterThan(20);
  });
});
