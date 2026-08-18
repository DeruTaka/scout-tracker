import { fetchReplay, normalizeReplayId } from './src/replay/fetch.ts';
import { extractObservations } from './src/ev/field-tracker.ts';

const id = normalizeReplayId('smogtours-gen9ubers-962535');
const replay = await fetchReplay(id);
const obs = extractObservations(replay);

const koraidonObs = obs.filter((o) => o.defenderSpecies.toLowerCase().includes('koraidon'));
console.log(`Total observations: ${obs.length}, Koraidon-as-defender: ${koraidonObs.length}\n`);
for (const o of koraidonObs) {
  console.log(JSON.stringify(o, null, 2));
  console.log('---');
}
