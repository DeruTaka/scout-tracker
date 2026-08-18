import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as calc from '@smogon/calc';
import { parseReplay } from '../src/replay/parse.js';
import { extractObservations } from '../src/ev/field-tracker.js';
import { deriveEvs, deriveSpeed, type SideSets } from '../src/ev/engine.js';
import { matchSet } from '../src/match/match-set.js';
import { getSetsForSpecies } from '../src/data/sets-provider.js';
import { genFromFormatId, getGen } from '../src/data/dex.js';
import type { DamageObservation, MatchedSet, Replay, SpeedObservation, StatsTable } from '../src/types.js';

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

  it('derives bulk from a SINGLE hit when it is impossible under the prior, not just marginally low', () => {
    // 52% is below even the worst possible roll (55.3%) for a 0 HP / 0 Def
    // Zacian — that's not "one noisy data point", it's a mathematical
    // certainty that some bulk exists, even from n=1.
    const zac = zacian();
    const teams: SideSets[] = [{ side: 'p1', sets: [koraidon()] }, { side: 'p2', sets: [zac] }];
    deriveEvs(9, teams, [hit()]);
    expect(zac.evs).not.toEqual({ atk: 252, spd: 4, spe: 252 });
    expect((zac.evs.hp ?? 0) + (zac.evs.def ?? 0)).toBeGreaterThan(0);
    const total = (['hp', 'atk', 'def', 'spa', 'spd', 'spe'] as const).reduce((s, k) => s + (zac.evs[k] ?? 0), 0);
    expect(total).toBe(508);
    expect(zac.notes.some((n) => n.includes('Derived HP/DEF'))).toBe(true);
  });

  it('stays fully conservative on a single hit that is only marginally low (within rounding tolerance)', () => {
    // 54% is only 1.3 points under the 55.3% floor — inside TOL, i.e.
    // genuinely indistinguishable from HP%-rounding noise on the 0/0 prior.
    const zac = zacian();
    const teams: SideSets[] = [{ side: 'p1', sets: [koraidon()] }, { side: 'p2', sets: [zac] }];
    deriveEvs(9, teams, [{ ...hit(), observedPercent: 54 }]);
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
    // HP/Def came straight out of the defense-evidence search (0/0 for this
    // exact scenario) — Pass C must not perturb them, even though it's free
    // to top up the untested SpD.
    expect(kora.notes.some((n) => n.includes('Derived HP/DEF'))).toBe(true);
    const total = (['hp', 'atk', 'def', 'spa', 'spd', 'spe'] as const).reduce((s, k) => s + (kora.evs[k] ?? 0), 0);
    expect(total).toBe(508);
    expect(kora.evs.hp).toBe(0);
    expect(kora.evs.def).toBe(0);
    expect(kora.evs.spd).toBeGreaterThan(0);
    expect(kora.notes.some((n) => n.includes('Filled') && n.includes('SpD'))).toBe(true);
  });
});

describe('Multiscale / Shadow Shield only apply when the defender is actually at full HP', () => {
  // @smogon/calc gates Multiscale/Shadow Shield's 50% reduction on
  // defender.curHP() === defender.maxHP() — correctly conditional, but it
  // defaults curHP to max whenever the caller never says otherwise. Real
  // observations from smogtours-gen9ubers-955171: a 0-Atk Ho-Oh's Sacred
  // Fire (Sun) vs. a Shadow Shield Lunala already at 87% HP dealt 55% —
  // right in the plain (ability-inactive) 54.1-63.7% range. Without passing
  // the observation's actual HP%, the engine assumes Lunala is untouched,
  // halves the prediction to ~27-32%, and misreads the "shortfall" as Ho-Oh
  // needing an unrevealed Choice Band.
  it('a hit on an already-damaged Shadow Shield mon is not misread as attacker needing a boost item', () => {
    const hooh: MatchedSet = {
      species: 'Ho-Oh', baseSpecies: 'Ho-Oh', level: 100, shiny: false,
      moves: ['Sacred Fire'], revealedMoves: ['Sacred Fire'],
      item: 'Heavy-Duty Boots', itemRevealed: false, ability: 'Regenerator',
      nature: 'Impish', evs: { hp: 252, def: 252, spd: 4 },
      confidence: 0.7, notes: [], evSource: 'dex-set', choicePossible: true,
    };
    const lunala: MatchedSet = {
      species: 'Lunala', baseSpecies: 'Lunala', level: 100, shiny: false,
      moves: ['Moongeist Beam'], revealedMoves: ['Moongeist Beam'],
      item: 'Heavy-Duty Boots', itemRevealed: true, ability: 'Shadow Shield',
      nature: 'Timid', evs: { hp: 4, spa: 252, spe: 252 },
      confidence: 0.7, notes: [], evSource: 'dex-set', choicePossible: true,
    };
    const hit = (): DamageObservation => ({
      turn: 2, attackerSide: 'p1', attackerSpecies: 'Ho-Oh', defenderSide: 'p2',
      defenderSpecies: 'Lunala', move: 'Sacred Fire', observedPercent: 55,
      koCapped: false, field: {
        weather: 'SunnyDay', attackerBoosts: {}, defenderBoosts: { spa: 1, spd: 1 },
        reflect: false, lightScreen: false, auroraVeil: false,
        attackerHpPercent: 69, defenderHpPercent: 87,
      }, crit: false, usable: true,
    });
    const teams: SideSets[] = [{ side: 'p1', sets: [hooh] }, { side: 'p2', sets: [lunala] }];
    deriveEvs(9, teams, [hit(), hit()]);
    expect(hooh.item).toBe('Heavy-Duty Boots');
    expect(hooh.evs.atk ?? 0).toBe(0);
    expect(hooh.notes.some((n) => n.includes('Inferred') && n.includes('from damage output'))).toBe(false);
  });
});

describe('Intrepid Sword / Dauntless Shield do not double-count their own +1 stage', () => {
  // @smogon/calc unconditionally re-applies Intrepid Sword's +1 Atk inside
  // calculate() itself, as if the Pokemon had just freshly switched in — but
  // Gen 9 patched the ability to trigger only on a Pokemon's very first
  // entry, not on every re-entry. A re-entered Zacian-Crowned's ACTUAL boosts
  // (tracked from -boost/-unboost log lines, empty here) can legitimately
  // have no +1 active. If the engine didn't compensate, it would predict a
  // boosted 70.7-83.6% range for this exact hit and misread the ~13pp
  // shortfall as defender bulk that was never really there.
  it('a hit that only fits the unboosted range is not misread as defender bulk', () => {
    const zac: MatchedSet = {
      species: 'Zacian-Crowned', baseSpecies: 'Zacian-Crowned', level: 100, shiny: false,
      moves: ['Behemoth Blade'], revealedMoves: ['Behemoth Blade'],
      item: 'Rusted Sword', itemRevealed: true, ability: 'Intrepid Sword',
      nature: 'Jolly', evs: { atk: 252, spd: 4, spe: 252 },
      confidence: 0.7, notes: [], evSource: 'dex-set', choicePossible: true,
    };
    const kora: MatchedSet = {
      species: 'Koraidon', baseSpecies: 'Koraidon', level: 100, shiny: false,
      moves: ['Flame Charge'], revealedMoves: ['Flame Charge'],
      item: undefined, itemRevealed: false, ability: 'Orichalcum Pulse',
      nature: 'Jolly', evs: { atk: 252, def: 4, spe: 252 },
      confidence: 0.6, notes: [], evSource: 'dex-set', choicePossible: true,
    };
    // Real observed % from smogtours-gen9ubers-962535 turn 23 — a re-entered
    // Zacian-Crowned's Behemoth Blade vs. a plain 0 HP/4 Def Koraidon.
    const hit = (): DamageObservation => ({
      turn: 23, attackerSide: 'p1', attackerSpecies: 'Zacian-Crowned', defenderSide: 'p2',
      defenderSpecies: 'Koraidon', move: 'Behemoth Blade', observedPercent: 50,
      koCapped: false, field: {
        attackerBoosts: {}, defenderBoosts: {}, reflect: false, lightScreen: false,
        auroraVeil: false, attackerHpPercent: 100, defenderHpPercent: 100,
      }, crit: false, usable: true,
    });
    const teams: SideSets[] = [{ side: 'p1', sets: [zac] }, { side: 'p2', sets: [kora] }];
    deriveEvs(9, teams, [hit(), hit()]);
    expect(kora.evs.def).toBe(4);
    expect(kora.evs.hp ?? 0).toBe(0);
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

describe('leftover-EV fill has an emergency last resort when every other stat is blocked', () => {
  // A mon that takes BOTH a physical and special hit which each already fit
  // the maxed-offense prior (no correction needed — but both still count as
  // "weighed against damage taken", blocking hp/def/spd from Pass C) while a
  // separate weak offense hit pulls its own Atk down hard. Every normal
  // fallback stat (atk/spa always, hp/def/spd via defense evidence) ends up
  // blocked, and Speed is already maxed — nothing is left to absorb the
  // freed budget without the emergency tier.
  function zacian(): MatchedSet {
    return {
      species: 'Zacian-Crowned', baseSpecies: 'Zacian-Crowned', level: 100, shiny: false,
      moves: ['Behemoth Blade'], revealedMoves: ['Behemoth Blade'],
      item: 'Rusted Sword', itemRevealed: true, ability: 'Intrepid Sword',
      nature: 'Jolly', evs: { atk: 252, spd: 4, spe: 252 },
      confidence: 0.7, notes: [], evSource: 'dex-set', choicePossible: true,
    };
  }
  function arceus(): MatchedSet {
    return {
      species: 'Arceus', baseSpecies: 'Arceus', level: 100, shiny: false,
      moves: ['Extreme Speed'], revealedMoves: ['Extreme Speed'],
      item: 'Silk Scarf', itemRevealed: true, ability: 'Multitype',
      nature: 'Adamant', evs: { atk: 252 },
      confidence: 0.6, notes: [], evSource: 'dex-set', choicePossible: true,
    };
  }
  function kyogre(): MatchedSet {
    return {
      species: 'Kyogre', baseSpecies: 'Kyogre', level: 100, shiny: false,
      moves: ['Origin Pulse'], revealedMoves: ['Origin Pulse'],
      item: undefined, itemRevealed: false, ability: 'Drizzle',
      nature: 'Modest', evs: { spa: 252 },
      confidence: 0.6, notes: [], evSource: 'dex-set', choicePossible: true,
    };
  }
  function glimmoraFodder(): MatchedSet {
    return {
      species: 'Glimmora', baseSpecies: 'Glimmora', level: 100, shiny: false,
      moves: ['Power Gem'], revealedMoves: ['Power Gem'],
      item: 'Focus Sash', itemRevealed: true, ability: 'Toxic Debris',
      nature: 'Timid', evs: { spa: 4 },
      confidence: 0.6, notes: [], evSource: 'dex-set', choicePossible: true,
    };
  }
  const fieldBase = {
    attackerBoosts: {}, defenderBoosts: {}, reflect: false, lightScreen: false,
    auroraVeil: false, attackerHpPercent: 100, defenderHpPercent: 100,
  };
  // Percentages a maxed-Atk Arceus/Kyogre deal to the dex-default 0 HP/4 SpD
  // Zacian prior — pre-computed via @smogon/calc so both defense categories
  // "confirm, don't correct" (priorV under KEEP_THRESHOLD).
  function physHit(): DamageObservation {
    return {
      turn: 3, attackerSide: 'p1', attackerSpecies: 'Arceus', defenderSide: 'p2',
      defenderSpecies: 'Zacian-Crowned', move: 'Extreme Speed', observedPercent: 24.134615384615383,
      koCapped: false, field: fieldBase, crit: false, usable: true,
    };
  }
  function specHit(): DamageObservation {
    return {
      turn: 5, attackerSide: 'p1', attackerSpecies: 'Kyogre', defenderSide: 'p2',
      defenderSpecies: 'Zacian-Crowned', move: 'Origin Pulse', observedPercent: 65.01923076923077,
      koCapped: false, field: fieldBase, crit: false, usable: true,
    };
  }
  function weakOffenseHit(): DamageObservation {
    return {
      turn: 7, attackerSide: 'p2', attackerSpecies: 'Zacian-Crowned', defenderSide: 'p1',
      defenderSpecies: 'Glimmora', move: 'Behemoth Blade', observedPercent: 20,
      koCapped: false, field: fieldBase, crit: false, usable: true,
    };
  }

  it('fills the leftover budget by nudging a passively-confirmed stat rather than leaving the spread incomplete', () => {
    const zac = zacian();
    const teams: SideSets[] = [
      { side: 'p1', sets: [arceus(), kyogre(), glimmoraFodder()] },
      { side: 'p2', sets: [zac] },
    ];
    deriveEvs(9, teams, [physHit(), physHit(), specHit(), specHit(), weakOffenseHit(), weakOffenseHit()]);
    expect(zac.evSource).toBe('derived');
    expect(zac.evs.atk).toBeLessThan(252); // offense evidence genuinely pulled Atk down
    const total = (['hp', 'atk', 'def', 'spa', 'spd', 'spe'] as const).reduce((s, k) => s + (zac.evs[k] ?? 0), 0);
    expect(total).toBe(508);
    expect(zac.notes.some((n) => n.includes('Filled') && n.includes("didn't add up"))).toBe(true);
    // HP alone has plenty of room to absorb the leftover — Speed should
    // never even be touched here, let alone be the FIRST place it lands.
    expect(zac.evs.spe).toBe(252);
    expect(zac.evs.hp).toBeGreaterThan(0);
  });
});

describe('Def and SpD are refined jointly, not as two independent passes that overwrite each other', () => {
  // Reproduces the Ho-Oh bug: a mon takes both a physical AND a special hit.
  // Processed independently, 'def' alone would want HP high; 'spd' alone,
  // run second, could freely zero HP back out to fit ITS OWN evidence,
  // silently invalidating the 'def' fit that was never re-checked. A real
  // mixed wall's HP has to work for BOTH categories at once.
  const gen9 = calc.Generations.get(9);
  function pct(defenderEvs: Partial<StatsTable>, move: string, attackerEvs: Partial<StatsTable>, attackerSpecies: string, attackerNature: string) {
    const result = calc.calculate(
      gen9,
      new calc.Pokemon(gen9, attackerSpecies, { level: 100, nature: attackerNature, evs: attackerEvs }),
      new calc.Pokemon(gen9, 'Ho-Oh', { level: 100, item: 'Heavy-Duty Boots', ability: 'Regenerator', nature: 'Careful', evs: defenderEvs }),
      new calc.Move(gen9, move),
    );
    const dmg = (Array.isArray(result.damage) ? result.damage : [result.damage]) as number[];
    const avg = dmg.reduce((a, b) => a + b, 0) / dmg.length;
    return (avg / result.defender.maxHP()) * 100;
  }
  // A genuinely mixed-bulk target: real investment in both HP and SpD, and
  // some (not maxed) Def — the same shape as a real bulky Ho-Oh.
  const targetEvs = { hp: 248, def: 148, spd: 112 };
  const physPct = pct(targetEvs, 'Brave Bird', { atk: 252 }, 'Arceus', 'Adamant');
  const specPct = pct(targetEvs, 'Judgment', { spa: 252 }, 'Arceus', 'Modest');

  function hoOh(): MatchedSet {
    return {
      species: 'Ho-Oh', baseSpecies: 'Ho-Oh', level: 100, shiny: false,
      moves: ['Sacred Fire', 'Brave Bird'], revealedMoves: ['Sacred Fire', 'Brave Bird'],
      item: 'Heavy-Duty Boots', itemRevealed: true, ability: 'Regenerator',
      nature: 'Impish', evs: { hp: 252, def: 252, spd: 4 },
      confidence: 0.6, notes: [], evSource: 'dex-set', choicePossible: true,
    };
  }
  function attacker(species: string): MatchedSet {
    return {
      species, baseSpecies: species, level: 100, shiny: false,
      moves: [], revealedMoves: [],
      item: undefined, itemRevealed: false, ability: 'Multitype',
      nature: 'Serious', evs: {},
      confidence: 0.5, notes: [], evSource: 'dex-set', choicePossible: true,
    };
  }
  const fieldBase = {
    attackerBoosts: {}, defenderBoosts: {}, reflect: false, lightScreen: false,
    auroraVeil: false, attackerHpPercent: 100, defenderHpPercent: 100,
  };
  function physHit(): DamageObservation {
    return {
      turn: 3, attackerSide: 'p1', attackerSpecies: 'Arceus', defenderSide: 'p2',
      defenderSpecies: 'Ho-Oh', move: 'Brave Bird', observedPercent: physPct,
      koCapped: false, field: fieldBase, crit: false, usable: true,
    };
  }
  function specHit(): DamageObservation {
    return {
      turn: 5, attackerSide: 'p1', attackerSpecies: 'Arceus', defenderSide: 'p2',
      defenderSpecies: 'Ho-Oh', move: 'Judgment', observedPercent: specPct,
      koCapped: false, field: fieldBase, crit: false, usable: true,
    };
  }

  it('never lands on the self-contradictory HP-zeroed / one-stat-maxed pattern', () => {
    const hooh = hoOh();
    const teams: SideSets[] = [{ side: 'p1', sets: [attacker('Arceus')] }, { side: 'p2', sets: [hooh] }];
    deriveEvs(9, teams, [physHit(), physHit(), specHit(), specHit()]);
    const total = (['hp', 'atk', 'def', 'spa', 'spd', 'spe'] as const).reduce((s, k) => s + (hooh.evs[k] ?? 0), 0);
    expect(total).toBe(508);
    // The old bug: 'spd' running second would zero HP back out even though
    // 'def' evidence needed it. Whatever this lands on, it must not be the
    // degenerate "HP gutted AND a defense stat gutted" combination.
    const hp = hooh.evs.hp ?? 0;
    const def = hooh.evs.def ?? 0;
    const spd = hooh.evs.spd ?? 0;
    expect(hp === 0 && (def === 0 || spd === 0)).toBe(false);
  });
});

describe('joint defense search stays robust and does not perturb an already-fine category', () => {
  // Reproduces smogtours-gen9ubers-956423: a single physical hit that's
  // impossible under 0 Def (52% vs a 55.3-65.2% floor) alongside two special
  // hits that already fit the 0-SpD prior fine. Two regressions this guards
  // against: (1) an earlier version chased the exact roll MIDPOINT and
  // landed on an extreme, edge-case Def value (156) instead of a robust one
  // — but a uniform 16-roll distribution gives no likelihood reason to
  // prefer the midpoint over any other in-range point, so that's the wrong
  // criterion; (2) SpD drifted away from its already-fitting prior (4) to
  // 12 purely chasing marginal robustness, despite zero actual violation.
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
  function kyogre(): MatchedSet {
    return {
      species: 'Kyogre', baseSpecies: 'Kyogre', level: 100, shiny: false,
      moves: ['Ice Beam', 'Thunder'], revealedMoves: ['Ice Beam', 'Thunder'],
      item: undefined, itemRevealed: false, ability: 'Drizzle',
      nature: 'Modest', evs: { spa: 252, spe: 4 },
      confidence: 0.6, notes: [], evSource: 'dex-set', choicePossible: true,
    };
  }
  const fieldBase = {
    attackerBoosts: {}, defenderBoosts: {}, reflect: false, lightScreen: false,
    auroraVeil: false, attackerHpPercent: 76, defenderHpPercent: 94,
  };
  function physHit(): DamageObservation {
    return {
      turn: 14, attackerSide: 'p1', attackerSpecies: 'Koraidon', defenderSide: 'p2',
      defenderSpecies: 'Zacian-Crowned', move: 'Flame Charge', observedPercent: 52,
      koCapped: false, field: { ...fieldBase, attackerTera: 'Fire' }, crit: false, usable: true,
    };
  }
  function specHitIceBeam(): DamageObservation {
    return {
      turn: 20, attackerSide: 'p1', attackerSpecies: 'Kyogre', defenderSide: 'p2',
      defenderSpecies: 'Zacian-Crowned', move: 'Ice Beam', observedPercent: 13,
      koCapped: false, field: fieldBase, crit: false, usable: true,
    };
  }
  function specHitThunder(): DamageObservation {
    return {
      turn: 22, attackerSide: 'p1', attackerSpecies: 'Kyogre', defenderSide: 'p2',
      defenderSpecies: 'Zacian-Crowned', move: 'Thunder', observedPercent: 23,
      koCapped: true, field: fieldBase, crit: false, usable: true,
    };
  }

  it('derives a robust Def value and leaves the already-fitting SpD untouched', () => {
    const zac = zacian();
    const teams: SideSets[] = [
      { side: 'p1', sets: [koraidon(), kyogre()] },
      { side: 'p2', sets: [zac] },
    ];
    deriveEvs(9, teams, [physHit(), specHitIceBeam(), specHitThunder()]);
    expect(zac.evs.def).toBeGreaterThan(0);
    expect(zac.evs.def).toBeLessThan(100); // NOT the edge-case extreme (156)
    expect(zac.evs.spd).toBe(4); // untouched — was already fine, never violated
    const total = (['hp', 'atk', 'def', 'spa', 'spd', 'spe'] as const).reduce((s, k) => s + (zac.evs[k] ?? 0), 0);
    expect(total).toBe(508);
  });
});
