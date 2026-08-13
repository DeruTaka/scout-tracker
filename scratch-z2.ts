import { fetchReplay } from './src/replay/fetch.js';
import { scoutReplay } from './src/scout.js';
const replay = await fetchReplay('smogtours-gen9ubers-959148');
const s = await scoutReplay(replay);
for (const t of s.teams) {
  console.log(`\n===== ${t.player} =====`);
  for (const ms of t.sets) console.log(`${ms.species} @ ${ms.item ?? '(none)'}  [${ms.ability ?? '?'}]  ${ms.nature} ${JSON.stringify(ms.evs)}  conf=${ms.confidence.toFixed(2)}`);
}
