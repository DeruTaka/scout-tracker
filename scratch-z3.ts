import { fetchReplay } from './src/replay/fetch.js';
import { scoutReplay } from './src/scout.js';
const replay = await fetchReplay('smogtours-gen9ubers-959148');
const s = await scoutReplay(replay);
const t = s.teams.find(t=>t.player==='Taka')!;
for (const ms of t.sets) {
  console.log(`\n${ms.species} @ ${ms.item ?? '(none)'} [${ms.ability ?? '?'}] ${ms.nature} ${JSON.stringify(ms.evs)} tera=${ms.tera??'-'}`);
  console.log(`  role: ${ms.matchedRole}`);
  for (const n of ms.notes) console.log('  - ' + n);
}
