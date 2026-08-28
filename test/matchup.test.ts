import { describe, it, expect } from 'vitest';
import { Datastore } from '../src/store/datastore.js';
import { getGen } from '../src/data/dex.js';
import { parseUsageTable, parseScoutingDigest, buildThreatProfile } from '../src/matchup/threat-profile.js';
import { scoreMatchup } from '../src/matchup/score.js';
import { getHistoricalWinRates } from '../src/matchup/historical.js';
import { buildCounterTeam } from '../src/matchup/team-builder.js';
import type { MatchedSet, Replay, ScoutedReplay } from '../src/types.js';

const gen = getGen(9);

function mon(overrides: Partial<MatchedSet>): MatchedSet {
  return {
    species: overrides.species!,
    baseSpecies: overrides.baseSpecies ?? overrides.species!,
    level: 100,
    shiny: false,
    moves: [],
    revealedMoves: [],
    item: undefined,
    itemRevealed: false,
    ability: undefined,
    nature: 'Serious',
    evs: {},
    confidence: 0.7,
    notes: [],
    evSource: 'derived',
    choicePossible: true,
    ...overrides,
  };
}

describe('parseUsageTable', () => {
  it('parses the box-table format (Rank/Pokemon/Use/Usage%/Win%)', () => {
    const text = `+ ---- + -------- + ---- + ------- + ------- +
| Rank | Pokemon  | Use  | Usage % |  Win %  |
+ ---- + -------- + ---- + ------- + ------- +
| 1    | Koraidon |   71 |  94.67% |  50.70% |
| 2    | Kyogre   |   41 |  54.67% |  51.22% |
`;
    const rows = parseUsageTable(text);
    expect(rows).toBeTruthy();
    expect(rows!.length).toBe(2);
    expect(rows![0]).toMatchObject({ species: 'Koraidon', weight: 94.67, winPercent: 50.7, count: 71 });
    expect(rows![1]).toMatchObject({ species: 'Kyogre', weight: 54.67, winPercent: 51.22, count: 41 });
  });

  it('returns null for text with no header row', () => {
    expect(parseUsageTable('just some random text\nwith no table in it')).toBeNull();
  });
});

describe('parseScoutingDigest', () => {
  it('weights species by how many of the listed rosters include them', () => {
    const text = `tester (gen9ubers):

Koraidon, Zacian-Crowned:
https://replay.pokemonshowdown.com/smogtours-gen9ubers-1

Koraidon
- Scale Shot

Zacian-Crowned
Ability: Intrepid Sword
- Behemoth Blade


Koraidon, Kyogre:
https://replay.pokemonshowdown.com/smogtours-gen9ubers-2

Koraidon
- Low Kick

Kyogre
Ability: Drizzle
- Origin Pulse
`;
    const digest = parseScoutingDigest(text);
    expect(digest).toBeTruthy();
    expect(digest!.player).toBe('tester');
    expect(digest!.formatid).toBe('gen9ubers');
    const koraidon = digest!.threats.find((t) => t.species === 'Koraidon')!;
    expect(koraidon.weight).toBe(100); // in both rosters
    const zacian = digest!.threats.find((t) => t.species === 'Zacian-Crowned')!;
    expect(zacian.weight).toBe(50); // in 1 of 2 rosters
  });

  it('returns null when no roster/URL pairs are found', () => {
    expect(parseScoutingDigest('just a random paragraph\nwith no roster lines at all')).toBeNull();
  });
});

describe('buildThreatProfile', () => {
  it('prefers a usage table over a URL when both are present in the input', async () => {
    const text = `Check out https://pokepast.es/doesnotmatter and also:
| Rank | Pokemon  | Use | Usage % | Win % |
| 1    | Koraidon |  10 |  100.00% |  50.00% |
| 2    | Kyogre   |   5 |   50.00% |  60.00% |
`;
    const profile = await buildThreatProfile(gen, text, { fetchPokepaste: async () => { throw new Error('should not be called'); } });
    expect(profile.source).toBe('usage-table');
    expect(profile.threats[0]!.species).toBe('Koraidon');
  });

  it('falls back to fetching a PokePaste URL when no table is present', async () => {
    const digestText = `tester (gen9ubers):

Koraidon, Zacian-Crowned:
https://replay.pokemonshowdown.com/smogtours-gen9ubers-1

Koraidon
- Scale Shot

Zacian-Crowned
- Behemoth Blade
`;
    const profile = await buildThreatProfile(gen, 'https://pokepast.es/abc123', { fetchPokepaste: async () => digestText });
    expect(profile.source).toBe('pokepaste-digest');
    expect(profile.threats.map((t) => t.species).sort()).toEqual(['Koraidon', 'Zacian-Crowned']);
  });
});

describe('scoreMatchup', () => {
  const charizard = mon({
    species: 'Charizard', baseSpecies: 'Charizard', ability: 'Blaze', nature: 'Modest',
    evs: { spa: 252, spe: 252 }, moves: ['Fire Blast'],
  });
  const ferrothorn = mon({
    species: 'Ferrothorn', baseSpecies: 'Ferrothorn', ability: 'Iron Barbs', nature: 'Relaxed',
    evs: { hp: 252, def: 252 }, moves: ['Power Whip'],
  });

  it('heavily favors a fast, 4x-super-effective attacker over a slow resisted wall', () => {
    const result = scoreMatchup(9, charizard, ferrothorn);
    expect(result.candidateFaster).toBe(true);
    expect(result.candidateDamagePercent).toBeGreaterThan(result.threatDamagePercent);
    expect(result.score).toBeGreaterThan(50);
  });

  it('is unfavorable from the other side of the same matchup', () => {
    const result = scoreMatchup(9, ferrothorn, charizard);
    expect(result.candidateFaster).toBe(false);
    expect(result.score).toBeLessThan(-50);
  });
});

function replayWithWinner(id: string, winner: string, mine: MatchedSet[], theirs: MatchedSet[]): ScoutedReplay {
  const replay: Replay = {
    id, url: `https://replay.pokemonshowdown.com/${id}`, format: '[Gen 9] Ubers', formatid: 'gen9customtest',
    gen: 9, players: ['Me', 'Them'], log: '', uploadtime: 1700000000, winner,
  };
  return {
    replay, scoutedAt: Date.now(),
    teams: [
      { player: 'Me', side: 'p1', sets: mine, paste: 'placeholder' },
      { player: 'Them', side: 'p2', sets: theirs, paste: 'placeholder' },
    ],
  };
}

describe('getHistoricalWinRates', () => {
  it('only counts games where the opponent fielded 2+ threat species', () => {
    const store = new Datastore('/nonexistent/matchup-hist-store.json');
    const threats = new Set(['koraidon', 'zaciancrowned']);
    // Qualifies: opponent has both threats, "Me" (with Blissey) wins.
    store.ingest(replayWithWinner('r1', 'Me',
      [mon({ species: 'Blissey', baseSpecies: 'Blissey' })],
      [mon({ species: 'Koraidon', baseSpecies: 'Koraidon' }), mon({ species: 'Zacian-Crowned', baseSpecies: 'Zacian-Crowned' })]));
    // Qualifies: same shape, "Me" wins again.
    store.ingest(replayWithWinner('r2', 'Me',
      [mon({ species: 'Blissey', baseSpecies: 'Blissey' })],
      [mon({ species: 'Koraidon', baseSpecies: 'Koraidon' }), mon({ species: 'Zacian-Crowned', baseSpecies: 'Zacian-Crowned' })]));
    // Does NOT qualify: opponent only has 1 threat species.
    store.ingest(replayWithWinner('r3', 'Them',
      [mon({ species: 'Blissey', baseSpecies: 'Blissey' })],
      [mon({ species: 'Koraidon', baseSpecies: 'Koraidon' })]));

    const rates = getHistoricalWinRates(store, 'gen9customtest', threats);
    const blissey = rates.get('blissey')!;
    expect(blissey.total).toBe(2);
    expect(blissey.wins).toBe(2);
  });
});

describe('buildCounterTeam', () => {
  it('picks up to 6 distinct, real, non-threat species from the local store', async () => {
    const store = new Datastore('/nonexistent/matchup-team-store.json');
    const formatid = 'gen9customtest';

    const threatSets: MatchedSet[] = [
      mon({ species: 'Zacian-Crowned', baseSpecies: 'Zacian-Crowned', ability: 'Intrepid Sword', item: 'Rusted Sword', nature: 'Jolly', evs: { atk: 252, spe: 252 }, moves: ['Behemoth Blade'] }),
      mon({ species: 'Koraidon', baseSpecies: 'Koraidon', ability: 'Orichalcum Pulse', item: 'Loaded Dice', nature: 'Jolly', evs: { atk: 252, spe: 252 }, moves: ['Scale Shot'] }),
    ];
    const candidateSpecies = ['Ho-Oh', 'Lunala', 'Eternatus', 'Arceus-Fairy', 'Ting-Lu', 'Landorus-Therian', 'Kyogre'];
    const candidateSets = candidateSpecies.map((species, i) =>
      mon({
        species, baseSpecies: species, ability: 'Pressure', nature: 'Bold',
        evs: { hp: 252, def: 252 }, moves: ['Body Press'],
        confidence: 0.7, evSource: i % 2 === 0 ? 'derived' : 'dex-set',
      }),
    );

    store.ingest(replayWithWinner('rA', 'Me', [candidateSets[0]!, candidateSets[1]!], threatSets));
    store.ingest(replayWithWinner('rB', 'Me', [candidateSets[2]!, candidateSets[3]!], threatSets));
    store.ingest(replayWithWinner('rC', 'Them', [candidateSets[4]!, candidateSets[5]!, candidateSets[6]!], threatSets));
    store.ingest(replayWithWinner('rD', 'Opponent', threatSets, [candidateSets[0]!]));
    store.rebuildUniqueSets();

    const threats = await buildThreatProfile(gen, `
| Rank | Pokemon        | Use | Usage % | Win % |
| 1    | Zacian-Crowned |   4 |  100.00% |  50.00% |
| 2    | Koraidon       |   4 |  100.00% |  50.00% |
`);
    const result = await buildCounterTeam(store, gen, formatid, threats);

    expect(result.team.length).toBeGreaterThan(0);
    expect(result.team.length).toBeLessThanOrEqual(6);
    const species = result.team.map((t) => t.species);
    expect(new Set(species).size).toBe(species.length); // no duplicates
    expect(species).not.toContain('Zacian-Crowned');
    expect(species).not.toContain('Koraidon');
    for (const pick of result.team) {
      expect(pick.set.moves.length).toBeGreaterThan(0);
      expect(pick.rationale.length).toBeGreaterThan(0);
    }
  }, 20000);
});
