import { describe, it, expect } from 'vitest';
import { Datastore } from '../src/store/datastore.js';
import { getGen, speciesMeta, toID } from '../src/data/dex.js';
import { parseUsageTable, parseScoutingDigest, buildThreatProfile } from '../src/matchup/threat-profile.js';
import { scoreMatchup } from '../src/matchup/score.js';
import { getHistoricalWinRates } from '../src/matchup/historical.js';
import { buildCounterTeam, pickBestMandatoryVariant } from '../src/matchup/team-builder.js';
import { getBestKnownSet } from '../src/matchup/candidate-pool.js';
import { _clearVrCacheForTests, _clearSavedVrMapForTests } from '../src/matchup/vr-thread.js';
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

  it('a Trick Room user acts first (and isn\'t discounted) despite being literally slower', () => {
    // Torkoal (base 20 Speed) into Dragapult (base 142) — Torkoal never wins
    // a real speed check, but Trick Room flips that, so its own damage
    // should count at full value instead of the "might get hit first"
    // discount a plain slow attacker eats.
    const dragapult = mon({ species: 'Dragapult', baseSpecies: 'Dragapult', nature: 'Timid', evs: { spe: 252, hp: 4 }, moves: [] });
    const trTorkoal = mon({
      species: 'Torkoal', baseSpecies: 'Torkoal', nature: 'Quiet', item: 'Choice Specs',
      evs: { spa: 252, hp: 252 }, moves: ['Trick Room', 'Eruption'],
    });
    const plainTorkoal = mon({
      species: 'Torkoal', baseSpecies: 'Torkoal', nature: 'Quiet', item: 'Choice Specs',
      evs: { spa: 252, hp: 252 }, moves: ['Eruption'],
    });

    const withTR = scoreMatchup(9, trTorkoal, dragapult);
    const withoutTR = scoreMatchup(9, plainTorkoal, dragapult);

    expect(withTR.candidateFaster).toBe(false);
    expect(withTR.candidateActsFirst).toBe(true); // Trick Room overrides the raw speed check
    expect(withoutTR.candidateActsFirst).toBe(false);
    // Same attacker, same move, same target — only the Trick Room discount
    // and speed-bonus sign differ, so this isolates that effect.
    expect(withTR.score).toBeGreaterThan(withoutTR.score + 20);
  });

  it('rewards naturally outspeeding over merely outspeeding via Choice Scarf', () => {
    // Same species/move/Atk investment both ways — only speed method differs,
    // so any score gap traces to score.ts's NATURAL_SPEED_BONUS_MULT alone.
    const registeel = mon({ species: 'Registeel', baseSpecies: 'Registeel', nature: 'Relaxed', evs: { hp: 252, def: 252 }, moves: [] });
    const naturallyFast = mon({
      species: 'Conkeldurr', baseSpecies: 'Conkeldurr', nature: 'Serious',
      evs: { atk: 252, spe: 252 }, moves: ['Drain Punch'],
    });
    const scarfReliant = mon({
      species: 'Conkeldurr', baseSpecies: 'Conkeldurr', nature: 'Serious', item: 'Choice Scarf',
      evs: { atk: 252, hp: 252 }, ivs: { spe: 0 }, moves: ['Drain Punch'],
    });

    const naturalResult = scoreMatchup(9, naturallyFast, registeel);
    const scarfResult = scoreMatchup(9, scarfReliant, registeel);

    expect(naturalResult.candidateFaster).toBe(true);
    expect(naturalResult.candidateNaturallyFaster).toBe(true);
    expect(scarfResult.candidateFaster).toBe(true); // only wins the speed check because of the Scarf
    expect(scarfResult.candidateNaturallyFaster).toBe(false);
    expect(naturalResult.score).toBeGreaterThan(scarfResult.score);
  });
});

function replayWithWinner(id: string, winner: string, mine: MatchedSet[], theirs: MatchedSet[], uploadtime = 1700000000, formatid = 'gen9customtest'): ScoutedReplay {
  const replay: Replay = {
    id, url: `https://replay.pokemonshowdown.com/${id}`, format: '[Gen 9] Ubers', formatid,
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
    const formatid = 'gen9ubers'; // Koraidon is a gen9ubers-specific mandatory pick (see tier-config.ts)

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
    const formatid = 'gen9ubers'; // Steel/Dark/Fairy requirements are gen9ubers-specific (see tier-config.ts)

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

  it('never fields two Pokemon carrying the same entry hazard move', async () => {
    const store = new Datastore('/nonexistent/matchup-hazard-store.json');
    const formatid = 'gen9customtest';

    const threatSets: MatchedSet[] = [
      mon({ species: 'Kyogre', baseSpecies: 'Kyogre', ability: 'Drizzle', nature: 'Timid', evs: { spa: 252, spe: 252 }, moves: ['Water Spout'] }),
      mon({ species: 'Lunala', baseSpecies: 'Lunala', ability: 'Shadow Shield', nature: 'Timid', evs: { spa: 252, spe: 252 }, moves: ['Moongeist Beam'] }),
    ];
    // Three real, independently-strong Stealth Rock setters and two Toxic
    // Spikes setters — if hazard dedup weren't enforced, several of these
    // would happily co-exist since each looks good on its own matchup merit.
    const rockers = ['Ting-Lu', 'Landorus-Therian', 'Arceus-Ground'].map((species) =>
      mon({ species, baseSpecies: species, ability: 'Pressure', nature: 'Impish', evs: { hp: 252, def: 252 }, moves: ['Stealth Rock', 'Earthquake'], evSource: 'derived' }),
    );
    const spikers = ['Glimmora', 'Hatterene'].map((species) =>
      mon({ species, baseSpecies: species, ability: 'Pressure', nature: 'Bold', evs: { hp: 252, spd: 252 }, moves: ['Toxic Spikes', 'Sludge Bomb'], evSource: 'derived' }),
    );

    let n = 0;
    for (const set of [...rockers, ...spikers]) {
      for (let rep = 0; rep < 5; rep++) {
        store.ingest(replayWithWinner(`haz${n++}`, 'Me', [set], threatSets));
      }
    }
    store.rebuildUniqueSets();

    const threats = await buildThreatProfile(gen, `
| Rank | Pokemon | Use | Usage % | Win % |
| 1    | Kyogre  |   4 |  100.00% |  50.00% |
| 2    | Lunala  |   4 |  100.00% |  50.00% |
`);
    const result = await buildCounterTeam(store, gen, formatid, threats);
    const rockCount = result.team.filter((p) => p.set.moves.some((m) => m.toLowerCase().replace(/[^a-z]/g, '') === 'stealthrock')).length;
    const spikesCount = result.team.filter((p) => p.set.moves.some((m) => m.toLowerCase().replace(/[^a-z]/g, '') === 'toxicspikes')).length;
    expect(rockCount).toBeLessThanOrEqual(1);
    expect(spikesCount).toBeLessThanOrEqual(1);
  }, 20000);

  it('applies gen9nationaldexubers-specific rules: Primal Groudon mandatory, Dark-or-Marshadow/Poison/Steel coverage, no D-tier VR picks', async () => {
    const store = new Datastore('/nonexistent/matchup-natdex-store.json');
    const formatid = 'gen9nationaldexubers';

    const threatSets: MatchedSet[] = [
      mon({ species: 'Rayquaza', baseSpecies: 'Rayquaza', ability: 'Air Lock', nature: 'Naive', evs: { atk: 252, spe: 252 }, moves: ['Dragon Ascent'] }),
      mon({ species: 'Kyogre-Primal', baseSpecies: 'Kyogre-Primal', ability: 'Primordial Sea', nature: 'Timid', evs: { spa: 252, spe: 252 }, moves: ['Water Spout'] }),
    ];

    // Groudon-Primal (mandatory, S+) — needs to actually resolve via
    // speciesMeta's National-Dex fallback, not just the gen9 regional dex.
    const groudonPrimal = mon({ species: 'Groudon-Primal', baseSpecies: 'Groudon-Primal', ability: 'Desolate Land', nature: 'Adamant', evs: { atk: 252, hp: 252 }, moves: ['Precipice Blades'], evSource: 'derived' });
    // Marshadow (A+) satisfies the Dark-or-Marshadow requirement despite
    // being Fighting/Ghost, not Dark.
    const marshadow = mon({ species: 'Marshadow', baseSpecies: 'Marshadow', ability: 'Technician', nature: 'Jolly', evs: { atk: 252, spe: 252 }, moves: ['Spectral Thief'], evSource: 'derived' });
    // Ferrothorn (B+) is the Steel requirement's satisfier.
    const ferrothorn = mon({ species: 'Ferrothorn', baseSpecies: 'Ferrothorn', ability: 'Iron Barbs', nature: 'Relaxed', evs: { hp: 252, def: 252 }, moves: ['Gyro Ball'], evSource: 'derived' });
    // Glimmora (B-) is Poison/Rock — the Poison requirement's satisfier —
    // and carries the team's Choice Scarf speed control. A full 4-move,
    // full-EV set on purpose: Glimmora's real Smogon fallback set runs
    // Stealth Rock, which would collide with Groudon-Primal's own (also
    // real) Stealth Rock set under hazard dedup if fillRealisticSet ever
    // padded this one out — giving it a complete set up front means it
    // never needs padding.
    const glimmora = mon({ species: 'Glimmora', baseSpecies: 'Glimmora', item: 'Choice Scarf', ability: 'Toxic Debris', nature: 'Timid', evs: { spa: 252, spe: 252, hp: 4 }, moves: ['Sludge Wave', 'Earth Power', 'Energy Ball', 'Mortal Spin'], evSource: 'derived' });
    // Ho-Oh (S-) is real, strong, VR-ranked filler.
    const hooh = mon({ species: 'Ho-Oh', baseSpecies: 'Ho-Oh', ability: 'Regenerator', nature: 'Adamant', evs: { atk: 252, hp: 252 }, moves: ['Sacred Fire'], evSource: 'derived' });
    // Arceus-Fairy (A+) satisfies both the new Arceus-forme requirement and
    // the Fairy requirement (naturally Fairy-typed) at once.
    const arceusFairy = mon({ species: 'Arceus-Fairy', baseSpecies: 'Arceus-Fairy', ability: 'Multitype', nature: 'Timid', evs: { hp: 252, spa: 252, spe: 4 }, moves: ['Judgment', 'Recover', 'Calm Mind', 'Ice Beam'], evSource: 'derived' });
    // Shaymin-Sky is explicitly D-tier on the real VR list ("unviable, but
    // Ubers by tiering") — given a strong matchup move but deliberately kept
    // UNDER the local-recurrence bypass threshold, so the only way it could
    // make the team is if VR-based viability filtering isn't actually wired
    // up.
    const shayminSky = mon({ species: 'Shaymin-Sky', baseSpecies: 'Shaymin-Sky', ability: 'Serene Grace', nature: 'Timid', evs: { spa: 252, spe: 252 }, moves: ['Air Slash'], evSource: 'derived' });

    let n = 0;
    for (const set of [groudonPrimal, marshadow, ferrothorn, glimmora, hooh, arceusFairy]) {
      for (let rep = 0; rep < 4; rep++) {
        store.ingest(replayWithWinner(`nd${n++}`, 'Me', [set], threatSets, 1700000000, formatid));
      }
    }
    // Only 2 sightings — below MIN_LOCAL_RECURRENCE (3), so Shaymin-Sky
    // can't sneak in through the local-recurrence bypass either.
    for (let rep = 0; rep < 2; rep++) {
      store.ingest(replayWithWinner(`nd${n++}`, 'Me', [shayminSky], threatSets, 1700000000, formatid));
    }
    store.rebuildUniqueSets();

    const threats = await buildThreatProfile(gen, `
| Rank | Pokemon      | Use | Usage % | Win % |
| 1    | Rayquaza     |   4 |  100.00% |  50.00% |
| 2    | Kyogre-Primal|   4 |  100.00% |  50.00% |
`);
    // The real VR list is fetched fresh on every call (see vr-thread.ts) —
    // stub that fetch with a small fixture so this test stays deterministic
    // and offline instead of depending on Smogon's live thread content.
    // fetchLiveVrMap refuses a suspiciously small parse (MIN_PLAUSIBLE_ENTRIES),
    // so this pads the D tier with real, resolvable filler species past that
    // floor — they're excluded from the candidate pool either way (D never
    // passes viability), so they can't affect what the test actually asserts.
    const dFiller = ['Kyogre', 'Palkia', 'Dialga', 'Zacian', 'Reshiram', 'Solgaleo', 'Lugia', 'Palafin',
      'Darkrai', 'Deoxys', 'Genesect', 'Naganadel', 'Dragapult', 'Espathra', 'Baxcalibur', 'Urshifu',
      'Landorus', 'Sneasler', 'Cresselia', 'Terapagos', 'Melmetal', 'Zekrom', 'Magearna', 'Spectrier',
      'Annihilape', 'Roaring Moon', 'Iron Bundle', 'Grimmsnarl', 'Gothitelle', 'Hatterene', 'Shuckle',
      'Chansey', 'Dondozo', 'Kingambit', 'Mewtwo', 'Ribombee', 'Alomomola', 'Pheromosa', 'Rayquaza',
      'Chien-Pao', 'Fezandipiti', 'Ditto', 'Arceus', 'Lunala', 'Eternatus', 'Yveltal', 'Smeargle',
      'Chi-Yu', 'Garganacl',
    ].map((sp) => `${sp}<br />`).join('\n');
    const fakeVrHtml = `
<article class="message message--post">
<div class="message-body">
National Dex Ubers Ranking Tier List [Last Update: fixture]<br />
<br />
S+<br />
<br />
<a href="https://www.smogon.com/dex/sv/pokemon/groudon/national-dex-ubers/">Primal Groudon</a><br />
<br />
S-<br />
<a href="https://www.smogon.com/dex/sv/pokemon/ho-oh/national-dex-ubers/">Ho-Oh</a><br />
<br />
A+<br />
<a href="https://www.smogon.com/dex/sv/pokemon/marshadow/national-dex-ubers/">Marshadow</a><br />
<a href="https://www.smogon.com/dex/sv/pokemon/arceus/national-dex-ubers/fairy">Arceus-Fairy</a><br />
<br />
B+<br />
<a href="https://www.smogon.com/dex/sv/pokemon/ferrothorn/national-dex-ubers/">Ferrothorn</a><br />
<br />
B-<br />
<a href="https://www.smogon.com/dex/sv/pokemon/glimmora/national-dex-ubers/">Glimmora</a><br />
<br />
D Rank<br />
Reminder: These Pokemon are unviable, but Ubers by tiering.<br />
Shaymin-S<br />
${dFiller}
<br />
Rules<br />
</div>
</article>
<article class="message message--post" data-author="someoneelse">
</article>`;
    const fakeFetch = (async () => ({ ok: true, text: async () => fakeVrHtml })) as unknown as typeof fetch;

    _clearVrCacheForTests(); // don't let another test's cached fetch for this same URL short-circuit this one
    const result = await buildCounterTeam(store, gen, formatid, threats, fakeFetch);
    const species = result.team.map((t) => t.species);

    expect(species).toContain('Groudon-Primal'); // mandatory for this tier
    expect(species).not.toContain('Shaymin-Sky'); // D-tier on the VR list, and under the local-recurrence bypass

    const hasSteel = result.team.some((p) => speciesMeta(gen, p.set.baseSpecies)?.types.map((x) => x.toLowerCase()).includes('steel'));
    const hasDarkOrMarshadow = result.team.some(
      (p) => speciesMeta(gen, p.set.baseSpecies)?.types.map((x) => x.toLowerCase()).includes('dark') ||
        (p.set.tera ?? '').toLowerCase() === 'dark' || p.species === 'Marshadow',
    );
    const hasPoison = result.team.some((p) => speciesMeta(gen, p.set.baseSpecies)?.types.map((x) => x.toLowerCase()).includes('poison') || (p.set.tera ?? '').toLowerCase() === 'poison');
    const hasFairy = result.team.some((p) => speciesMeta(gen, p.set.baseSpecies)?.types.map((x) => x.toLowerCase()).includes('fairy') || (p.set.tera ?? '').toLowerCase() === 'fairy');
    const hasArceus = result.team.some((p) => toID(speciesMeta(gen, p.set.baseSpecies)?.baseSpecies ?? p.species).startsWith('arceus'));
    expect(hasSteel).toBe(true);
    expect(hasDarkOrMarshadow).toBe(true);
    expect(hasPoison).toBe(true);
    expect(hasFairy).toBe(true); // Arceus-Fairy's own natural typing satisfies this
    expect(hasArceus).toBe(true); // the new "an Arceus forme" requirement
    expect(result.unmetRequirements).toEqual([]);
  }, 20000);

  it('prefers reassigning an existing top-tier pick\'s Tera over importing a lower-tier natural-type mon for a type-or-Tera requirement', async () => {
    const store = new Datastore('/nonexistent/matchup-tera-reassign-store.json');
    const formatid = 'gen9nationaldexubers';
    const threatSets: MatchedSet[] = [
      mon({ species: 'Rayquaza', baseSpecies: 'Rayquaza', ability: 'Air Lock', nature: 'Naive', evs: { atk: 252, spe: 252 }, moves: ['Dragon Ascent'] }),
      mon({ species: 'Kyogre-Primal', baseSpecies: 'Kyogre-Primal', ability: 'Primordial Sea', nature: 'Timid', evs: { spa: 252, spe: 252 }, moves: ['Water Spout'] }),
    ];
    const groudonPrimal = mon({ species: 'Groudon-Primal', baseSpecies: 'Groudon-Primal', ability: 'Desolate Land', nature: 'Adamant', evs: { atk: 252, hp: 252 }, moves: ['Precipice Blades', 'Fire Punch', 'Stone Edge', 'Toxic'], evSource: 'derived' });
    const marshadow = mon({ species: 'Marshadow', baseSpecies: 'Marshadow', ability: 'Technician', nature: 'Jolly', evs: { atk: 252, spe: 252 }, moves: ['Spectral Thief', 'Close Combat', 'Ice Punch', 'Bulk Up'], evSource: 'derived' });
    const ferrothorn = mon({ species: 'Ferrothorn', baseSpecies: 'Ferrothorn', ability: 'Iron Barbs', nature: 'Relaxed', evs: { hp: 252, def: 252 }, moves: ['Gyro Ball', 'Leech Seed', 'Knock Off', 'Body Press'], evSource: 'derived' });
    const hooh = mon({ species: 'Ho-Oh', baseSpecies: 'Ho-Oh', ability: 'Regenerator', nature: 'Adamant', evs: { atk: 252, hp: 252 }, moves: ['Sacred Fire', 'Brave Bird', 'Recover', 'Whirlwind'], evSource: 'derived' });
    // Two more real, strong, top-tier options — enough that the search's
    // own picks (by matchup + quality alone, before any repair pass runs)
    // can fill all 6 slots without ever touching the low-tier option below.
    const lunala = mon({ species: 'Lunala', baseSpecies: 'Lunala', ability: 'Shadow Shield', nature: 'Timid', evs: { spa: 252, spe: 252, hp: 4 }, moves: ['Moongeist Beam', 'Moonblast', 'Psyshock', 'Calm Mind'], evSource: 'derived' });
    // Yveltal, not Eternatus — Eternatus is naturally Poison/Dragon, which
    // would satisfy the Poison requirement outright and defeat the point
    // of this test (it needs to actually reach the Tera-reassignment path).
    const yveltal = mon({ species: 'Yveltal', baseSpecies: 'Yveltal', ability: 'Dark Aura', nature: 'Timid', evs: { spa: 252, spe: 252, hp: 4 }, moves: ['Oblivion Wing', 'Dark Pulse', 'Taunt', 'Roost'], evSource: 'derived' });
    // A real, but only C- tier, natural Poison-type — legal and viable
    // enough to be a candidate, but clearly lower-ranked than every pick
    // above. If the repair pass reaches for this just because it naturally
    // has the right type instead of Tera-ing an existing top pick, that's
    // exactly the regression this test guards against.
    const lowTierPoison = mon({ species: 'Weezing', baseSpecies: 'Weezing', ability: 'Levitate', nature: 'Bold', evs: { hp: 252, def: 252 }, moves: ['Sludge Bomb', 'Will-O-Wisp', 'Pain Split', 'Toxic Spikes'], evSource: 'derived' });

    let n = 0;
    for (const set of [groudonPrimal, marshadow, ferrothorn, hooh, lunala, yveltal, lowTierPoison]) {
      for (let rep = 0; rep < 5; rep++) {
        store.ingest(replayWithWinner(`tera${n++}`, 'Me', [set], threatSets, 1700000000, formatid));
      }
    }
    store.rebuildUniqueSets();

    const threats = await buildThreatProfile(gen, `
| Rank | Pokemon      | Use | Usage % | Win % |
| 1    | Rayquaza     |   4 |  100.00% |  50.00% |
| 2    | Kyogre-Primal|   4 |  100.00% |  50.00% |
`);
    const dFiller = ['Kyogre', 'Palkia', 'Dialga', 'Zacian', 'Reshiram', 'Solgaleo', 'Lugia', 'Palafin',
      'Darkrai', 'Deoxys', 'Genesect', 'Naganadel', 'Dragapult', 'Espathra', 'Baxcalibur', 'Urshifu',
      'Landorus', 'Sneasler', 'Cresselia', 'Terapagos', 'Melmetal', 'Zekrom', 'Magearna', 'Spectrier',
      'Annihilape', 'Roaring Moon', 'Iron Bundle', 'Grimmsnarl', 'Gothitelle', 'Hatterene', 'Shuckle',
      'Chansey', 'Dondozo', 'Kingambit', 'Mewtwo', 'Ribombee', 'Alomomola', 'Pheromosa', 'Rayquaza',
      'Chien-Pao', 'Fezandipiti', 'Ditto', 'Arceus', 'Eternatus', 'Smeargle',
      'Chi-Yu', 'Garganacl',
    ].map((sp) => `${sp}<br />`).join('\n');
    const fakeVrHtml = `
<article class="message message--post">
<div class="message-body">
National Dex Ubers Ranking Tier List [Last Update: fixture]<br />
<br />
S+<br />
<br />
<a href="https://www.smogon.com/dex/sv/pokemon/groudon/national-dex-ubers/">Primal Groudon</a><br />
<br />
S-<br />
<a href="https://www.smogon.com/dex/sv/pokemon/ho-oh/national-dex-ubers/">Ho-Oh</a><br />
<br />
A+<br />
<a href="https://www.smogon.com/dex/sv/pokemon/marshadow/national-dex-ubers/">Marshadow</a><br />
<a href="https://www.smogon.com/dex/sv/pokemon/yveltal/national-dex-ubers/">Yveltal</a><br />
<br />
A<br />
<a href="https://www.smogon.com/dex/sv/pokemon/lunala/national-dex-ubers/">Lunala</a><br />
<br />
B+<br />
<a href="https://www.smogon.com/dex/sv/pokemon/ferrothorn/national-dex-ubers/">Ferrothorn</a><br />
<br />
C-<br />
<a href="https://www.smogon.com/dex/sv/pokemon/weezing/national-dex-ubers/">Weezing</a><br />
<br />
D Rank<br />
Reminder: These Pokemon are unviable, but Ubers by tiering.<br />
${dFiller}
<br />
Rules<br />
</div>
</article>
<article class="message message--post" data-author="someoneelse">
</article>`;
    const fakeFetch = (async () => ({ ok: true, text: async () => fakeVrHtml })) as unknown as typeof fetch;

    _clearVrCacheForTests();
    const result = await buildCounterTeam(store, gen, formatid, threats, fakeFetch);
    const species = result.team.map((t) => t.species);

    // Poison coverage should come from an existing top-tier pick's Tera,
    // not by importing the much-lower-tier Weezing.
    expect(species).not.toContain('Weezing');
    const poisonSatisfier = result.team.find(
      (p) => speciesMeta(gen, p.set.baseSpecies)?.types.map((x) => x.toLowerCase()).includes('poison') || (p.set.tera ?? '').toLowerCase() === 'poison',
    );
    expect(poisonSatisfier).toBeDefined();
    expect((poisonSatisfier!.set.tera ?? '').toLowerCase()).toBe('poison');
    // Either repair path is a legitimate way to land here: reassigning this
    // pick's Tera slot (no real precedent needed beyond fit), or swapping in
    // a different real, already-evidenced set for the SAME species that
    // happens to carry Tera Poison natively (checked first — it's strictly
    // better-evidenced when available). Either way this must NOT be the
    // species-swap fallback (which would show up as "Added for required").
    expect(
      poisonSatisfier!.rationale.some(
        (r) => r.includes('Tera changed to Poison') || r.includes('Switched to a real set that also covers required Poison'),
      ),
    ).toBe(true);
    expect(result.unmetRequirements).not.toContain('Poison coverage (type or Tera)');
  }, 20000);

  it('pickBestMandatoryVariant flexes off a hazard move that only nominally scores best, but not when the hazard variant is clearly stronger', () => {
    const rocks = { set: mon({ species: 'Groudon-Primal', moves: ['Stealth Rock', 'Precipice Blades'] }), standaloneCeiling: 100, source: 'dex' as const };
    const attackClose = { set: mon({ species: 'Groudon-Primal', moves: ['Swords Dance', 'Precipice Blades'] }), standaloneCeiling: 90, source: 'dex' as const };
    // Within MANDATORY_HAZARD_FLEX_MARGIN (15) of the hazard variant — real
    // teambuilding runs the attacking set here specifically so something
    // else can hold the hazard role without a hazard-dedup conflict.
    expect(pickBestMandatoryVariant([rocks, attackClose])).toBe(attackClose);

    const attackFar = { set: mon({ species: 'Groudon-Primal', moves: ['Swords Dance', 'Precipice Blades'] }), standaloneCeiling: 50, source: 'dex' as const };
    // Far below the margin — the hazard variant is genuinely, meaningfully
    // better, so it's kept despite the hazard-dedup risk.
    expect(pickBestMandatoryVariant([rocks, attackFar])).toBe(rocks);

    // No non-hazard alternative at all — nothing to flex to.
    expect(pickBestMandatoryVariant([rocks])).toBe(rocks);

    // No hazard involved anywhere — plain best-scoring wins, unaffected.
    const attack1 = { set: mon({ species: 'Groudon-Primal', moves: ['Swords Dance'] }), standaloneCeiling: 80, source: 'dex' as const };
    const attack2 = { set: mon({ species: 'Groudon-Primal', moves: ['Rock Polish'] }), standaloneCeiling: 95, source: 'dex' as const };
    expect(pickBestMandatoryVariant([attack1, attack2])).toBe(attack2);
  });

  it('pickBestMandatoryVariant always prefers a dex-analysis/local variant over a usage-stats one, regardless of score, whenever one exists', () => {
    const usageBest = { set: mon({ species: 'Groudon-Primal', moves: ['Precipice Blades', 'Heat Crash'] }), standaloneCeiling: 100, source: 'usage' as const };
    const dexClose = { set: mon({ species: 'Groudon-Primal', moves: ['Rock Polish', 'Swords Dance'] }), standaloneCeiling: 85, source: 'dex' as const };
    // A written dex analysis is more trustworthy than "whatever the top
    // usage-stats spread happened to be against this one opponent," so it
    // wins even though it scored lower here.
    expect(pickBestMandatoryVariant([usageBest, dexClose])).toBe(dexClose);

    const dexFar = { set: mon({ species: 'Groudon-Primal', moves: ['Rock Polish', 'Swords Dance'] }), standaloneCeiling: 50, source: 'dex' as const };
    // Even when the usage-stats variant scores far higher, ANY real
    // dex-analysis/local variant still wins — this is an absolute
    // preference, not a soft score margin (a flat margin was consistently
    // too small to matter against real matchup score spreads in practice).
    expect(pickBestMandatoryVariant([usageBest, dexFar])).toBe(dexFar);

    // Only a usage-stats variant available at all — nothing to flex to.
    expect(pickBestMandatoryVariant([usageBest])).toBe(usageBest);
  });

  it('resolves Groudon-Primal/Kyogre-Primal dex-analysis sets via Smogon\'s base-species page (they don\'t get their own), filtered to the orb item', async () => {
    const store = new Datastore('/nonexistent/matchup-primal-dexsets-store.json');
    const formatid = 'gen9nationaldexubers';
    // No local data at all — this exercises the real dex-analysis fallback
    // (Smogon bundles Primal-forme sets onto the base "Groudon"/"Kyogre"
    // page rather than a dedicated one) end to end, including the Red/Blue
    // Orb item filter.
    const known = await getBestKnownSet(store, gen, formatid, 'Groudon-Primal');
    expect(known).not.toBeNull();
    expect(known!.source).toBe('dex'); // not a fallback to usage stats
    expect(toID(known!.set.item ?? '')).toBe('redorb');
    expect(known!.set.baseSpecies).toBe('Groudon-Primal');
  }, 20000);

  it('falls back to the bundled VR snapshot (with a warning) when the live fetch fails and there is no saved copy either', async () => {
    const store = new Datastore('/nonexistent/matchup-vr-bundled-fallback-store.json');
    const formatid = 'gen9nationaldexubers';
    const threatSets: MatchedSet[] = [
      mon({ species: 'Zacian-Crowned', baseSpecies: 'Zacian-Crowned', ability: 'Intrepid Sword', nature: 'Jolly', evs: { atk: 252, spe: 252 }, moves: ['Behemoth Blade'] }),
    ];
    store.ingest(replayWithWinner('vrfail0', 'Me', [mon({ species: 'Blissey', baseSpecies: 'Blissey' })], threatSets, 1700000000, formatid));
    store.rebuildUniqueSets();
    const threats = await buildThreatProfile(gen, `
| Rank | Pokemon        | Use | Usage % | Win % |
| 1    | Zacian-Crowned |   4 |  100.00% |  50.00% |
| 2    | Kyogre         |   4 |  100.00% |  50.00% |
`);
    // A fetch that always fails (network down / a hosted deployment's IP
    // blocked by Smogon's forum bot-protection — the real, reported case),
    // AND no on-disk saved copy from a prior successful fetch either (a
    // deployment that has genuinely never once gotten through) — this used
    // to have nothing left to fall back to and hard-fail outright, reading
    // like a real teambuilding problem. Now it uses the real snapshot
    // bundled with the app instead, still builds a real team, and says so.
    const alwaysFailFetch = (async () => { throw new Error('HTTP 403 (blocked)'); }) as unknown as typeof fetch;
    _clearVrCacheForTests();
    _clearSavedVrMapForTests(formatid);
    const result = await buildCounterTeam(store, gen, formatid, threats, alwaysFailFetch);
    expect(result.team.some((p) => p.species === 'Groudon-Primal')).toBe(true); // mandatory pick still resolved
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toMatch(/bundled with the app/);
  }, 20000);

  it('falls back to the last successfully-fetched VR list (with a warning) when the live fetch fails but a saved copy exists', async () => {
    const store = new Datastore('/nonexistent/matchup-vr-fallback-store.json');
    const formatid = 'gen9nationaldexubers';
    const threatSets: MatchedSet[] = [
      mon({ species: 'Zacian-Crowned', baseSpecies: 'Zacian-Crowned', ability: 'Intrepid Sword', nature: 'Jolly', evs: { atk: 252, spe: 252 }, moves: ['Behemoth Blade'] }),
    ];
    const threats = await buildThreatProfile(gen, `
| Rank | Pokemon        | Use | Usage % | Win % |
| 1    | Zacian-Crowned |   4 |  100.00% |  50.00% |
| 2    | Kyogre         |   4 |  100.00% |  50.00% |
`);
    const dFiller = ['Kyogre', 'Palkia', 'Dialga', 'Zacian', 'Reshiram', 'Solgaleo', 'Lugia', 'Palafin',
      'Darkrai', 'Deoxys', 'Genesect', 'Naganadel', 'Dragapult', 'Espathra', 'Baxcalibur', 'Urshifu',
      'Landorus', 'Sneasler', 'Cresselia', 'Terapagos', 'Melmetal', 'Zekrom', 'Magearna', 'Spectrier',
      'Annihilape', 'Roaring Moon', 'Iron Bundle', 'Grimmsnarl', 'Gothitelle', 'Hatterene', 'Shuckle',
      'Chansey', 'Dondozo', 'Kingambit', 'Mewtwo', 'Ribombee', 'Alomomola', 'Pheromosa', 'Rayquaza',
      'Chien-Pao', 'Fezandipiti', 'Ditto', 'Arceus', 'Lunala', 'Eternatus', 'Yveltal', 'Smeargle',
      'Chi-Yu', 'Garganacl',
    ].map((sp) => `${sp}<br />`).join('\n');
    const fakeVrHtml = `
<article class="message message--post">
<div class="message-body">
National Dex Ubers Ranking Tier List [Last Update: fixture]<br />
<br />
S+<br />
<br />
<a href="https://www.smogon.com/dex/sv/pokemon/groudon/national-dex-ubers/">Primal Groudon</a><br />
<br />
D Rank<br />
Reminder: These Pokemon are unviable, but Ubers by tiering.<br />
${dFiller}
<br />
Rules<br />
</div>
</article>
<article class="message message--post" data-author="someoneelse">
</article>`;
    const succeedingFetch = (async () => ({ ok: true, text: async () => fakeVrHtml })) as unknown as typeof fetch;

    // First, a successful fetch — this is what populates the on-disk
    // last-known-good copy in real usage.
    _clearVrCacheForTests();
    const first = await buildCounterTeam(store, gen, formatid, threats, succeedingFetch);
    expect(first.warnings).toEqual([]);
    expect(first.team.some((p) => p.species === 'Groudon-Primal')).toBe(true);

    // Now the live fetch fails outright (blocked/unreachable) — only the
    // in-memory cache needs clearing to force a real fetch attempt; the
    // on-disk copy from the call above should carry this one through.
    const alwaysFailFetch = (async () => { throw new Error('HTTP 403'); }) as unknown as typeof fetch;
    _clearVrCacheForTests();
    const second = await buildCounterTeam(store, gen, formatid, threats, alwaysFailFetch);
    expect(second.team.some((p) => p.species === 'Groudon-Primal')).toBe(true); // still built a real team
    expect(second.warnings.length).toBe(1);
    expect(second.warnings[0]).toMatch(/last successfully-fetched copy/);
  }, 20000);

  it('caps the number of resolved threats instead of scoring every row of a huge pasted usage table (regression: OOM on a full stats dump)', async () => {
    const store = new Datastore('/nonexistent/matchup-threat-cap-store.json');
    const formatid = 'gen9customtest';

    // A real usage-stats page can be hundreds of rows deep into <1% usage.
    // Every extra threat multiplies the per-candidate damage-calc work and
    // the size of every search node's coverage map — uncapped, this blew
    // the process heap in practice. Use 80 distinct real species (well past
    // any sane cap) as the "opponent's" full stats dump.
    const allReal: string[] = [];
    for (const sp of gen.species as unknown as Iterable<{ name: string; exists: boolean; isNonstandard?: string | null }>) {
      if (sp.exists && !sp.isNonstandard) allReal.push(sp.name);
      if (allReal.length >= 80) break;
    }
    const threatSets = allReal.map((species) => mon({ species, baseSpecies: species, moves: ['Tackle'] }));
    const candidateSets = ['Blissey', 'Skarmory', 'Chansey'].map((species) =>
      mon({ species, baseSpecies: species, ability: 'Pressure', nature: 'Bold', evs: { hp: 252, def: 252 }, moves: ['Body Press'], evSource: 'derived' }),
    );

    let n = 0;
    for (const set of candidateSets) {
      for (let rep = 0; rep < 3; rep++) store.ingest(replayWithWinner(`cap${n++}`, 'Me', [set], [threatSets[0]!], 1700000000, formatid));
    }
    // Seed every threat locally too, so resolving them never needs a
    // network fetch (keeps this test fast and offline).
    for (const set of threatSets) {
      store.ingest(replayWithWinner(`capT${n++}`, 'Them', [candidateSets[0]!], [set], 1700000000, formatid));
    }
    store.rebuildUniqueSets();

    const tableRows = allReal.map((sp, i) => `| ${i + 1} | ${sp} | 10 | ${(90 - i * 0.5).toFixed(2)}% | 50.00% |`).join('\n');
    const threats = await buildThreatProfile(gen, `| Rank | Pokemon | Use | Usage % | Win % |\n${tableRows}`);
    expect(threats.threats.length).toBe(80); // sanity: the full table did parse

    const result = await buildCounterTeam(store, gen, formatid, threats);
    expect(result.resolvedThreats.length).toBeLessThan(threats.threats.length);
    expect(result.resolvedThreats.length).toBeLessThanOrEqual(40);
    expect(result.team.length).toBeGreaterThan(0);
  }, 20000);
});
