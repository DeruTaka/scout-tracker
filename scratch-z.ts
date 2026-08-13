import { getGen } from './src/data/dex.js';
import * as calc from '@smogon/calc';
const gen = getGen(9);
for (const n of ['Zacian-Crowned','Zamazenta-Crowned','Aegislash-Blade','Charizard-Mega-X','Groudon-Primal','Palafin-Hero','Zacian-*','Zacian']) {
  const sp = gen.species.get(n.replace(/-\*$/,'')) as any;
  console.log(`${n.padEnd(18)} name=${sp?.name} base=${sp?.baseSpecies} battleOnly=${JSON.stringify(sp?.battleOnly)} requiredItem=${sp?.requiredItem} isMega=${sp?.isMega} forme=${sp?.forme}`);
}
// calc can build crowned?
const cg = calc.Generations.get(9);
for (const n of ['Zacian','Zacian-Crowned']) {
  try { const p = new calc.Pokemon(cg, n, {}); console.log('calc', n, 'atk stat=', p.stats.atk, 'ok'); } catch(e:any){ console.log('calc', n, 'FAIL', e.message); }
}
