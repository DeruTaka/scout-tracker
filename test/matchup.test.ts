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
    expect(koraidon.weight).toBe(100); // in both rosters, regardless of recency
    // Zacian-Crowned is only in the OLDER game (id 1 vs id 2) — recency decay
    // means its share is less than a flat 50/50 count would give it.
    const zacian = digest!.threats.find((t) => t.species === 'Zacian-Crowned')!;
    expect(zacian.weight).toBeLessThan(50);
    expect(zacian.weight).toBeGreaterThan(0);
  });

  it('weights a roster from a more recent replay id more heavily than an older one', () => {
    const newer = `t (gen9ubers):

Koraidon, Flutter Mane:
https://replay.pokemonshowdown.com/smogtours-gen9ubers-200

Koraidon
- Scale Shot

Flutter Mane
- Moonblast


Koraidon, Ho-Oh:
https://replay.pokemonshowdown.com/smogtours-gen9ubers-100

Koraidon
- Scale Shot

Ho-Oh
- Sacred Fire
`;
    const digest = parseScoutingDigest(newer);
    const flutterMane = digest!.threats.find((t) => t.species === 'Flutter Mane')!.weight; // newer game (id 200)
    const hoOh = digest!.threats.find((t) => t.species === 'Ho-Oh')!.weight; // older game (id 100)
    expect(flutterMane).toBeGreaterThan(hoOh);
  });

  it('does not silently drop a roster that lists multiple replay URLs', () => {
    const text = `t (gen9ubers):

Koraidon, Ting-Lu:
https://replay.pokemonshowdown.com/smogtours-gen9ubers-1
https://replay.pokemonshowdown.com/smogtours-gen9ubers-2

Koraidon
- Scale Shot

Ting-Lu
- Earthquake
`;
    const digest = parseScoutingDigest(text);
    expect(digest).toBeTruthy();
    const tingLu = digest!.threats.find((t) => t.species === 'Ting-Lu');
    expect(tingLu).toBeTruthy();
    expect(tingLu!.weight).toBe(100);
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

function replayWithWinner(id: string, winner: string, mine: MatchedSet[], theirs: MatchedSet[], uploadtime = 1700000000): ScoutedReplay {
  const replay: Replay = {
    id, url: `https://replay.pokemonshowdown.com/${id}`, format: '[Gen 9] Ubers', formatid: 'gen9customtest',
    gen: 9, players: ['Me', 'Them'], log: '', uploadtime, winner,
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
    expect(blissey.weightedWinPercent).toBe(100); // all wins, still 100% once weighted
  });

  it('weights recent games more heavily than old ones — a recent loss outweighs old wins', () => {
    const store = new Datastore('/nonexistent/matchup-hist-recency-store.json');
    const threats = new Set(['koraidon', 'zaciancrowned']);
    const DAY = 86400;
    const opp = [mon({ species: 'Koraidon', baseSpecies: 'Koraidon' }), mon({ species: 'Zacian-Crowned', baseSpecies: 'Zacian-Crowned' })];
    const mine = [mon({ species: 'Blissey', baseSpecies: 'Blissey' })];
    // Two wins 120 days ago (4 half-lives), one loss yesterday.
    store.ingest(replayWithWinner('old1', 'Me', mine, opp, 1700000000 - 120 * DAY));
    store.ingest(replayWithWinner('old2', 'Me', mine, opp, 1700000000 - 120 * DAY));
    store.ingest(replayWithWinner('recent', 'Them', mine, opp, 1700000000 - DAY));

    const rates = getHistoricalWinRates(store, 'gen9customtest', threats);
    const blissey = rates.get('blissey')!;
    expect(blissey.wins).toBe(2);
    expect(blissey.total).toBe(3);
    // Raw win rate is 67%, but the recent loss should pull the weighted
    // figure well below 50 since it heavily outweighs two stale wins.
    expect(blissey.weightedWinPercent).toBeLessThan(50);
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

    // Each candidate needs 3+ separate sightings to clear the new
    // recurrence bar (a single one-off local sighting is exactly how an
    // obscure, globally-unplayed forme slipped onto a real generated team).
    let n = 0;
    for (const set of candidateSets) {
      for (let rep = 0; rep < 3; rep++) {
        store.ingest(replayWithWinner(`r${n++}`, 'Me', [set], threatSets));
      }
    }
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
    expect(species).toContain('Koraidon'); // mandatory even though it's also a threat — mirrors are normal in real Ubers
    for (const pick of result.team) {
      expect(pick.set.moves.length).toBeGreaterThan(0);
      expect(pick.rationale.length).toBeGreaterThan(0);
    }
  }, 20000);

  it('completes a full 6-mon team even with a large candidate pool (regression: heuristic over-estimate stalling the search short of depth 6)', async () => {
    const store = new Datastore('/nonexistent/matchup-team-store2.json');
    const formatid = 'gen9customtest';

    const threatSets: MatchedSet[] = [
      mon({ species: 'Zacian-Crowned', baseSpecies: 'Zacian-Crowned', ability: 'Intrepid Sword', nature: 'Jolly', evs: { atk: 252, spe: 252 }, moves: ['Behemoth Blade'] }),
      mon({ species: 'Koraidon', baseSpecies: 'Koraidon', ability: 'Orichalcum Pulse', nature: 'Jolly', evs: { atk: 252, spe: 252 }, moves: ['Scale Shot'] }),
    ];
    // A wide, varied pool — large enough to reproduce the real-world stall
    // (which only showed up with dozens of real candidates, not a handful).
    const pool = [
      'Ho-Oh', 'Lunala', 'Eternatus', 'Arceus-Fairy', 'Ting-Lu', 'Landorus-Therian', 'Kyogre',
      'Kingambit', 'Necrozma-Dusk-Mane', 'Arceus-Ground', 'Arceus-Water', 'Glimmora', 'Hatterene',
      'Ribombee', 'Deoxys-Speed', 'Terapagos-Terastal', 'Flutter Mane', 'Chien-Pao', 'Great Tusk',
      'Iron Treads', 'Gholdengo', 'Skeledirge', 'Annihilape', 'Gliscor', 'Blissey', 'Dondozo',
      'Rayquaza', 'Mewtwo', 'Giratina-Origin', 'Groudon',
    ];
    const candidateSets = pool.map((species) =>
      mon({ species, baseSpecies: species, ability: 'Pressure', nature: 'Bold', evs: { hp: 252, def: 252 }, moves: ['Body Press'], confidence: 0.7, evSource: 'derived' }),
    );
    let n = 0;
    for (const set of candidateSets) {
      for (let rep = 0; rep < 3; rep++) {
        store.ingest(replayWithWinner(`pool${n++}`, 'Me', [set], threatSets));
      }
    }
    store.rebuildUniqueSets();

    const threats = await buildThreatProfile(gen, `
| Rank | Pokemon        | Use | Usage % | Win % |
| 1    | Zacian-Crowned |   4 |  100.00% |  50.00% |
| 2    | Koraidon       |   4 |  100.00% |  50.00% |
`);
    const result = await buildCounterTeam(store, gen, formatid, threats);
    expect(result.team.length).toBe(6);
    expect(new Set(result.team.map((t) => t.species)).size).toBe(6);
    // Species Clause: Arceus-Ground and Arceus-Water are both dex #493 —
    // this pool includes both, so this only holds if the clause is enforced.
    const arceusFormes = result.team.filter((t) => t.species.startsWith('Arceus'));
    expect(arceusFormes.length).toBeLessThanOrEqual(1);
  }, 30000);

  it('never fields two Pokemon that share a Pokedex number (Species Clause)', async () => {
    const store = new Datastore('/nonexistent/matchup-species-clause-store.json');
    const formatid = 'gen9customtest';

    const threatSets: MatchedSet[] = [
      mon({ species: 'Zacian-Crowned', baseSpecies: 'Zacian-Crowned', ability: 'Intrepid Sword', nature: 'Jolly', evs: { atk: 252, spe: 252 }, moves: ['Behemoth Blade'] }),
      mon({ species: 'Kyogre', baseSpecies: 'Kyogre', ability: 'Drizzle', nature: 'Timid', evs: { spa: 252, spe: 252 }, moves: ['Water Spout'] }),
    ];
    // Both Arceus formes are built to look like standout picks (max SpA,
    // a strong coverage move) — if Species Clause weren't enforced, the
    // search would happily take both since each independently scores well.
    const arceusGround = mon({ species: 'Arceus-Ground', baseSpecies: 'Arceus-Ground', ability: 'Multitype', nature: 'Modest', evs: { spa: 252, spe: 252 }, moves: ['Earth Power'], evSource: 'derived' });
    const arceusWater = mon({ species: 'Arceus-Water', baseSpecies: 'Arceus-Water', ability: 'Multitype', nature: 'Modest', evs: { spa: 252, spe: 252 }, moves: ['Hydro Pump'], evSource: 'derived' });
    const filler = ['Ho-Oh', 'Lunala', 'Eternatus', 'Ting-Lu', 'Landorus-Therian', 'Kyogre', 'Kingambit'].map((species) =>
      mon({ species, baseSpecies: species, ability: 'Pressure', nature: 'Bold', evs: { hp: 252, def: 252 }, moves: ['Body Press'], evSource: 'derived' }),
    );

    let n = 0;
    for (const set of [arceusGround, arceusWater, ...filler]) {
      for (let rep = 0; rep < 3; rep++) {
        store.ingest(replayWithWinner(`sc${n++}`, 'Me', [set], threatSets));
      }
    }
    store.rebuildUniqueSets();

    const threats = await buildThreatProfile(gen, `
| Rank | Pokemon        | Use | Usage % | Win % |
| 1    | Zacian-Crowned |   4 |  100.00% |  50.00% |
| 2    | Kyogre         |   4 |  100.00% |  50.00% |
`);
    const result = await buildCounterTeam(store, gen, formatid, threats);
    const arceusPicks = result.team.filter((t) => t.species.startsWith('Arceus'));
    expect(arceusPicks.length).toBeLessThanOrEqual(1);
  }, 20000);

  it('never recommends a tier-banned species, even with heavy local recurrence and a strong matchup', async () => {
    const store = new Datastore('/nonexistent/matchup-banned-store.json');
    const formatid = 'gen9customtest';

    const threatSets: MatchedSet[] = [
      mon({ species: 'Zacian-Crowned', baseSpecies: 'Zacian-Crowned', ability: 'Intrepid Sword', nature: 'Jolly', evs: { atk: 252, spe: 252 }, moves: ['Behemoth Blade'] }),
      mon({ species: 'Kyogre', baseSpecies: 'Kyogre', ability: 'Drizzle', nature: 'Timid', evs: { spa: 252, spe: 252 }, moves: ['Water Spout'] }),
    ];
    // Miraidon is real dex tier 'AG' — banned even from Ubers. Given a
    // devastating move and heavy local recurrence, it would win the search
    // outright if the legality gate didn't exist.
    const miraidon = mon({ species: 'Miraidon', baseSpecies: 'Miraidon', ability: 'Hadron Engine', nature: 'Timid', evs: { spa: 252, spe: 252 }, moves: ['Electro Drift'], evSource: 'derived' });
    const filler = ['Ho-Oh', 'Lunala', 'Eternatus', 'Ting-Lu', 'Landorus-Therian', 'Kingambit', 'Hatterene'].map((species) =>
      mon({ species, baseSpecies: species, ability: 'Pressure', nature: 'Bold', evs: { hp: 252, def: 252 }, moves: ['Body Press'], evSource: 'derived' }),
    );

    let n = 0;
    for (const set of [miraidon, ...filler]) {
      for (let rep = 0; rep < 5; rep++) {
        store.ingest(replayWithWinner(`ban${n++}`, 'Me', [set], threatSets));
      }
    }
    store.rebuildUniqueSets();

    const threats = await buildThreatProfile(gen, `
| Rank | Pokemon        | Use | Usage % | Win % |
| 1    | Zacian-Crowned |   4 |  100.00% |  50.00% |
| 2    | Kyogre         |   4 |  100.00% |  50.00% |
`);
    const result = await buildCounterTeam(store, gen, formatid, threats);
    expect(result.team.map((t) => t.species)).not.toContain('Miraidon');
  }, 20000);

  it('always satisfies Steel / Dark-or-Tera / Fairy-or-Tera coverage when a legal candidate can provide it', async () => {
    const store = new Datastore('/nonexistent/matchup-typereq-store.json');
    const formatid = 'gen9customtest';

    const threatSets: MatchedSet[] = [
      mon({ species: 'Kyogre', baseSpecies: 'Kyogre', ability: 'Drizzle', nature: 'Timid', evs: { spa: 252, spe: 252 }, moves: ['Water Spout'] }),
      mon({ species: 'Lunala', baseSpecies: 'Lunala', ability: 'Shadow Shield', nature: 'Timid', evs: { spa: 252, spe: 252 }, moves: ['Moongeist Beam'] }),
    ];
    // Strong-but-typeless-for-our-purposes filler (none are Steel/Dark/Fairy)
    // — scored to look better than the type-requirement candidates below, so
    // the search alone would fill the team with these and never touch
    // Steel/Dark/Fairy without the repair pass.
    const strongFiller = ['Ho-Oh', 'Necrozma-Dusk-Mane', 'Groudon', 'Terapagos-Terastal', 'Deoxys-Speed'].map((species) =>
      mon({ species, baseSpecies: species, ability: 'Pressure', nature: 'Adamant', evs: { atk: 252, spe: 252 }, moves: ['Close Combat'], evSource: 'derived' }),
    );
    // Real type-requirement candidates, deliberately weak (status move only)
    // so they'd lose to strongFiller on pure matchup score.
    const kingambit = mon({ species: 'Kingambit', baseSpecies: 'Kingambit', ability: 'Supreme Overlord', nature: 'Adamant', evs: { hp: 252, atk: 4, spe: 252 }, moves: ['Swords Dance'], evSource: 'derived' });
    const hatterene = mon({ species: 'Hatterene', baseSpecies: 'Hatterene', ability: 'Magic Bounce', nature: 'Calm', evs: { hp: 252, spd: 252 }, moves: ['Calm Mind'], evSource: 'derived' });

    let n = 0;
    for (const set of [...strongFiller, kingambit, hatterene]) {
      for (let rep = 0; rep < 5; rep++) {
        store.ingest(replayWithWinner(`treq${n++}`, 'Me', [set], threatSets));
      }
    }
    store.rebuildUniqueSets();

    const threats = await buildThreatProfile(gen, `
| Rank | Pokemon | Use | Usage % | Win % |
| 1    | Kyogre  |   4 |  100.00% |  50.00% |
| 2    | Lunala  |   4 |  100.00% |  50.00% |
`);
    const result = await buildCounterTeam(store, gen, formatid, threats);
    const hasSteel = result.team.some((p) => gen.species.get(p.set.baseSpecies)?.types.map((x) => x.toLowerCase()).includes('steel'));
    const hasDark = result.team.some((p) => gen.species.get(p.set.baseSpecies)?.types.map((x) => x.toLowerCase()).includes('dark') || (p.set.tera ?? '').toLowerCase() === 'dark');
    const hasFairy = result.team.some((p) => gen.species.get(p.set.baseSpecies)?.types.map((x) => x.toLowerCase()).includes('fairy') || (p.set.tera ?? '').toLowerCase() === 'fairy');
    expect(hasSteel).toBe(true);
    expect(hasDark).toBe(true);
    expect(hasFairy).toBe(true);
    expect(result.unmetRequirements).toEqual([]);
  }, 20000);
});
