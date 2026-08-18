import { fetchReplay, normalizeReplayId } from './src/replay/fetch.ts';
import { scoutReplay } from './src/scout.ts';
import { extractObservations } from './src/ev/field-tracker.ts';
import { getGen } from './src/data/dex.ts';
import * as calc from '@smogon/calc';

const id = normalizeReplayId('smogtours-gen9ubers-962535');
const replay = await fetchReplay(id);
const scouted = await scoutReplay(replay);
const obs = extractObservations(replay).filter((o) => o.defenderSpecies.toLowerCase().includes('koraidon') && !o.koCapped);

const gen = getGen(9);

for (const o of obs) {
  const attackerTeam = scouted.teams.find((t) => t.side === o.attackerSide);
  const zSet = attackerTeam.sets.find((s) => s.baseSpecies === 'Zacian-Crowned');
  console.log(`\nTurn ${o.turn}: attacker=${o.attackerSpecies} (${o.attackerSide}) matched set:`, JSON.stringify({
    item: zSet?.item, ability: zSet?.ability, nature: zSet?.nature, evs: zSet?.evs,
  }));

  const attacker = new calc.Pokemon(gen, 'Zacian-Crowned', {
    level: 100,
    item: zSet?.item || 'Rusted Sword',
    ability: zSet?.ability || 'Intrepid Sword',
    nature: zSet?.nature || 'Adamant',
    evs: zSet?.evs || { atk: 252 },
    boosts: o.field.attackerBoosts,
  });
  const defender = new calc.Pokemon(gen, 'Koraidon', {
    level: 100,
    ability: 'Orichalcum Pulse',
    nature: 'Jolly',
    evs: { hp: 0, def: 4 },
    boosts: o.field.defenderBoosts,
    status: o.field.defenderStatus,
  });
  const field = new calc.Field({
    weather: o.field.weather,
    defenderSide: new calc.Side({ isReflect: o.field.reflect, isLightScreen: o.field.lightScreen, isAuroraVeil: o.field.auroraVeil }),
  });
  const move = new calc.Move(gen, 'Behemoth Blade');
  const res = calc.calculate(gen, attacker, defender, move, field);
  const dmg = res.range();
  const max = defender.maxHP();
  console.log(`  0 HP/4 Def predicted: ${dmg[0]}-${dmg[1]} (${(dmg[0]/max*100).toFixed(1)}-${(dmg[1]/max*100).toFixed(1)}%) vs observed ${o.observedPercent}%`);
  console.log(`  attacker actual boosts on record: ${JSON.stringify(attacker.boosts)}, defender maxHP=${max}`);
  console.log(`  desc: ${res.desc()}`);
}
