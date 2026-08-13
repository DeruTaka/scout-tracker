import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseReplay } from '../src/replay/parse.js';
import { getGen, genFromFormatId, resolveSpecies } from '../src/data/dex.js';
import type { Replay } from '../src/types.js';

function loadFixture(name: string): Replay {
  const path = fileURLToPath(new URL(`./fixtures/${name}.json`, import.meta.url));
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  return {
    id: raw.id, url: '', format: raw.format, formatid: raw.formatid,
    gen: genFromFormatId(raw.formatid), players: raw.players, log: raw.log, uploadtime: raw.uploadtime,
  };
}

describe('forme resolution', () => {
  const gen = getGen(9);

  it('keeps item-locked formes and forces their item', () => {
    expect(resolveSpecies(gen, 'Zacian-Crowned')).toMatchObject({
      setKey: 'Zacian-Crowned',
      forcedItem: 'Rusted Sword',
    });
    expect(resolveSpecies(gen, 'Zamazenta-Crowned')).toMatchObject({
      setKey: 'Zamazenta-Crowned',
      forcedItem: 'Rusted Shield',
    });
  });

  it('reverts mid-battle stances to base (no forced item)', () => {
    expect(resolveSpecies(getGen(8), 'Aegislash-Blade').setKey).toBe('Aegislash');
    expect(resolveSpecies(gen, 'Palafin-Hero').setKey).toBe('Palafin');
  });

  it('merges the "Zacian-*" preview with the revealed Zacian-Crowned', () => {
    const replay = loadFixture('smogtours-gen9ubers-959148');
    const teams = parseReplay(replay);
    for (const team of teams) {
      // exactly one Zacian slot per side, resolved to Crowned + Rusted Sword
      const zacians = team.mons.filter((m) => m.baseSpecies.startsWith('Zacian'));
      expect(zacians).toHaveLength(1);
      expect(zacians[0]!.baseSpecies).toBe('Zacian-Crowned');
      expect(zacians[0]!.item).toBe('Rusted Sword');
      expect(team.mons).toHaveLength(6);
    }
  });
});
