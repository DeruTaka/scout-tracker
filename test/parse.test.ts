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
