import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseReplay } from '../src/replay/parse.js';
import { genFromFormatId } from '../src/data/dex.js';
import type { Replay } from '../src/types.js';

function loadFixture(name: string): Replay {
  const path = fileURLToPath(new URL(`./fixtures/${name}.json`, import.meta.url));
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  return {
    id: raw.id,
    url: `https://replay.pokemonshowdown.com/${raw.id}`,
    format: raw.format,
    formatid: raw.formatid,
    gen: genFromFormatId(raw.formatid),
    players: raw.players,
    log: raw.log,
    uploadtime: raw.uploadtime,
  };
}

describe('parseReplay: smogtours-gen8uu-963226', () => {
  const replay = loadFixture('smogtours-gen8uu-963226');
  const teams = parseReplay(replay);
  const taka = teams.find((t) => t.player === 'Taka')!;
  const royal = teams.find((t) => t.player === 'royal')!;

  const speciesSet = (t: typeof taka) => new Set(t.mons.map((m) => m.baseSpecies));
  const monMoves = (t: typeof taka, sp: string) =>
    new Set(t.mons.find((m) => m.baseSpecies === sp)?.moves ?? []);

  it('reconstructs both full 6-mon rosters', () => {
    expect(taka.mons).toHaveLength(6);
    expect(royal.mons).toHaveLength(6);
    expect(speciesSet(taka)).toEqual(
      new Set(['Thundurus', 'Zarude', 'Nidoqueen', 'Togekiss', 'Keldeo', 'Registeel']),
    );
    expect(speciesSet(royal)).toEqual(
      new Set(['Aegislash', 'Tapu Bulu', 'Seismitoad', 'Raikou', 'Umbreon', 'Noivern']),
    );
  });

  it('captures revealed moves', () => {
    expect(monMoves(taka, 'Nidoqueen')).toEqual(
      new Set(['Earth Power', 'Sludge Wave', 'Ice Beam', 'Protect']),
    );
    expect(monMoves(taka, 'Registeel')).toEqual(
      new Set(['Stealth Rock', 'Earthquake', 'Seismic Toss']),
    );
    expect(monMoves(royal, 'Umbreon')).toEqual(new Set(['Foul Play', 'Wish', 'Protect']));
    expect(monMoves(taka, 'Zarude')).toEqual(
      new Set(['U-turn', 'Darkest Lariat', 'Jungle Healing']),
    );
  });

  it('captures revealed items and abilities', () => {
    const nido = taka.mons.find((m) => m.baseSpecies === 'Nidoqueen')!;
    expect(nido.item).toBe('Black Sludge');
    const bulu = royal.mons.find((m) => m.baseSpecies === 'Tapu Bulu')!;
    expect(bulu.ability).toBe('Grassy Surge');
    const aegi = royal.mons.find((m) => m.baseSpecies === 'Aegislash')!;
    expect(aegi.ability).toBe('Stance Change');
    const keldeo = taka.mons.find((m) => m.baseSpecies === 'Keldeo')!;
    expect(keldeo.species).toBe('Keldeo-Resolute');
  });
});

function synthReplay(log: string): Replay {
  return {
    id: 'synthetic', url: '', format: '[Gen 9] OU', formatid: 'gen9ou', gen: 9,
    players: ['Alice', 'Bob'], log, uploadtime: 0,
  };
}

describe('proc items and Heavy-Duty Boots inference', () => {
  const log = [
    '|player|p1|Alice||', '|player|p2|Bob||',
    '|poke|p1|Garchomp|', '|poke|p1|Dragapult|', '|poke|p2|Ferrothorn|',
    '|teampreview', '|start',
    '|switch|p1a: Garchomp|Garchomp|100/100',
    '|switch|p2a: Ferrothorn|Ferrothorn|100/100',
    '|turn|1',
    '|move|p2a: Ferrothorn|Stealth Rock|p1a: Garchomp',
    '|-sidestart|p1: Alice|move: Stealth Rock',
    '|turn|2',
    // Dragapult switches into Stealth Rock and TAKES the damage → no Boots.
    '|switch|p1a: Dragapult|Dragapult|100/100',
    '|-damage|p1a: Dragapult|75/100|[from] Stealth Rock',
    '|turn|3',
    // Garchomp switches into Stealth Rock and takes NO damage → Heavy-Duty Boots.
    '|switch|p1a: Garchomp|Garchomp|100/100',
    '|move|p1a: Garchomp|Earthquake|p2a: Ferrothorn',
    '|-damage|p2a: Ferrothorn|60/100',
    // Contact triggers Ferrothorn's Rocky Helmet on Garchomp — the item is
    // Ferrothorn's, not Garchomp's.
    '|-damage|p1a: Garchomp|88/100|[from] item: Rocky Helmet|[of] p2a: Ferrothorn',
    '|turn|4',
  ].join('\n');

  const teams = parseReplay(synthReplay(log));
  const p1 = teams.find((t) => t.side === 'p1')!;
  const p2 = teams.find((t) => t.side === 'p2')!;
  const mon = (t: typeof p1, sp: string) => t.mons.find((m) => m.baseSpecies === sp)!;

  it('credits Rocky Helmet to the holder, not the mon it damaged', () => {
    expect(mon(p2, 'Ferrothorn').item).toBe('Rocky Helmet');
    expect(mon(p1, 'Garchomp').item).not.toBe('Rocky Helmet');
  });

  it('infers Heavy-Duty Boots for a mon that dodged Stealth Rock', () => {
    expect(mon(p1, 'Garchomp').item).toBe('Heavy-Duty Boots');
  });

  it('does NOT infer Boots for a mon that took hazard damage', () => {
    expect(mon(p1, 'Dragapult').item).toBeUndefined();
  });
});
