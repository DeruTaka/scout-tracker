import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseReplay } from '../src/replay/parse.js';
import { extractObservations } from '../src/ev/field-tracker.js';
import { deriveEvs, type SideSets } from '../src/ev/engine.js';
import { matchSet } from '../src/match/match-set.js';
import { getSetsForSpecies } from '../src/data/sets-provider.js';
import { genFromFormatId, getGen } from '../src/data/dex.js';
import type { MatchedSet, Replay } from '../src/types.js';

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
