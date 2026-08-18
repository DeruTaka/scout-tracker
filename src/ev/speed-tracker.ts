// Extract same-priority-bracket "who moved first" evidence from a battle log.
// This is the ONLY direct signal a replay gives about a mon's actual Speed —
// yet nothing in this tool used it before. Two mons acting on the same turn at
// equal move priority, with nothing else deciding the order (Trick Room noted
// separately; Quick Claw/Custap Berry/Quick Draw excluded outright), proves
// one had strictly higher effective Speed at that moment.
import type { Generation } from '@pkmn/data';
import type { Replay, SpeedObservation, StatsTable } from '../types.js';
import { getGen, resolveSpecies, toID } from '../data/dex.js';

type Side = 'p1' | 'p2';

interface SlotState {
  side: Side;
  setKey: string;
  boosts: Partial<StatsTable>;
  status?: string;
  tera?: string;
}

interface TurnAction {
  slot: string;
  side: Side;
  setKey: string;
  priority: number;
  boosts: Partial<StatsTable>;
  status?: string;
  tera?: string;
}

const PRIORITY_PROC_MARKERS = ['quick claw', 'custap berry', 'quick draw', 'mycelium might'];

function slotKey(token: string): string | null {
  const m = /^(p[12][a-c]):/.exec(token);
  return m ? m[1]! : null;
}
function sideOf(slot: string): Side {
  return slot.slice(0, 2) as Side;
}
function fields(line: string): string[] {
  return line.slice(1).split('|');
}
/** A switch/drag's HP field carries the mon's current status too (e.g.
 *  "100/100 par") when re-entering already afflicted — Showdown doesn't
 *  re-emit |-status| for a condition the mon already had, so a paralyzed mon
 *  switching back out and in would otherwise silently look un-paralyzed,
 *  hiding its 0.5x Speed penalty from every observation after that switch. */
function parseStatusSuffix(field: string | undefined): string | undefined {
  if (!field) return undefined;
  const m = /\b(par|psn|tox|brn|slp|frz)\b/.exec(field);
  return m ? m[1] : undefined;
}

/**
 * Abilities that bump a move into a different effective priority bracket (or,
 * for Mycelium Might, make it act as if last within its own bracket) without
 * changing the move's own dex priority value at all — so comparing raw
 * `move.priority` between two actions misses them entirely. We can't always
 * be sure WHICH ability a mon actually has, so this checks every ability the
 * species COULD have; if any of them would apply here, the turn order isn't
 * proof of relative Speed and gets excluded, same as a Quick Claw proc.
 */
function abilityMayAlterPriority(gen: Generation, setKey: string, move: { category: string; type: string; flags?: { heal?: number } }): boolean {
  const species = gen.species.get(setKey);
  if (!species) return false;
  const abilities = (Object.values(species.abilities) as string[]).map(toID);
  const isStatus = move.category === 'Status';
  return abilities.some((a) => {
    if (a === 'prankster' && isStatus) return true;
    if (a === 'myceliummight' && isStatus) return true;
    if (a === 'galewings' && move.type === 'Flying') return true;
    if (a === 'triage' && !!move.flags?.heal) return true;
    return false;
  });
}

export function extractSpeedObservations(replay: Replay): SpeedObservation[] {
  const gen = getGen(replay.gen);
  const out: SpeedObservation[] = [];
  const slots: Record<string, SlotState> = {};
  let trickRoom = false;
  let turn = 0;
  let actions: TurnAction[] = [];
  let procTainted = false; // a priority-bracket-bending proc happened this turn

  const flushTurn = () => {
    // Only usable when exactly two actions happened, from opposite sides, at
    // equal priority, with nothing else deciding who went first.
    if (!procTainted && actions.length === 2 && actions[0]!.side !== actions[1]!.side && actions[0]!.priority === actions[1]!.priority) {
      // Under Trick Room the LOWER-speed mon acts first, so swap here — callers
      // never need to think about Trick Room, "faster" always means faster.
      const [actedFirst, actedSecond] = actions as [TurnAction, TurnAction];
      const [first, second] = trickRoom ? [actedSecond, actedFirst] : [actedFirst, actedSecond];
      out.push({
        turn,
        fasterSide: first.side, fasterSpecies: first.setKey,
        slowerSide: second.side, slowerSpecies: second.setKey,
        fasterBoosts: { ...first.boosts }, slowerBoosts: { ...second.boosts },
        fasterStatus: first.status, slowerStatus: second.status,
        fasterTera: first.tera, slowerTera: second.tera,
        trickRoom,
      });
    }
    actions = [];
    procTainted = false;
  };

  for (const raw of replay.log.split('\n')) {
    if (!raw.startsWith('|')) continue;
    const f = fields(raw);
    const cmd = f[0];

    switch (cmd) {
      case 'turn':
        flushTurn();
        turn = Number(f[1]) || turn;
        break;
      case 'switch':
      case 'drag':
      case 'replace': {
        const slot = slotKey(f[1] || '');
        if (!slot) break;
        const speciesSeen = (f[2] || '').split(',')[0]!.trim();
        const { setKey } = resolveSpecies(gen, speciesSeen);
        slots[slot] = { side: sideOf(slot), setKey, boosts: {}, status: parseStatusSuffix(f[3]) };
        break;
      }
      case '-boost':
      case '-unboost': {
        const slot = slotKey(f[1] || '');
        const stat = f[2] as keyof StatsTable;
        const amt = (Number(f[3]) || 0) * (cmd === '-unboost' ? -1 : 1);
        if (slot && slots[slot] && stat) slots[slot].boosts[stat] = (slots[slot].boosts[stat] || 0) + amt;
        break;
      }
      case '-setboost': {
        const slot = slotKey(f[1] || '');
        const stat = f[2] as keyof StatsTable;
        if (slot && slots[slot] && stat) slots[slot].boosts[stat] = Number(f[3]) || 0;
        break;
      }
      case '-clearboost':
      case '-clearnegativeboost': {
        const slot = slotKey(f[1] || '');
        if (slot && slots[slot]) slots[slot].boosts = {};
        break;
      }
      case '-status': {
        const slot = slotKey(f[1] || '');
        if (slot && slots[slot]) slots[slot].status = f[2];
        break;
      }
      case '-curestatus': {
        const slot = slotKey(f[1] || '');
        if (slot && slots[slot]) slots[slot].status = undefined;
        break;
      }
      case '-terastallize': {
        const slot = slotKey(f[1] || '');
        if (slot && slots[slot]) slots[slot].tera = f[2];
        break;
      }
      case '-fieldstart': {
        if (/trick room/i.test(f[1] || '')) trickRoom = true;
        break;
      }
      case '-fieldend': {
        if (/trick room/i.test(f[1] || '')) trickRoom = false;
        break;
      }
      case '-activate': {
        const effect = (f[2] || '').toLowerCase();
        if (PRIORITY_PROC_MARKERS.some((m) => effect.includes(m))) procTainted = true;
        break;
      }
      case 'move': {
        const slot = slotKey(f[1] || '');
        if (!slot || !slots[slot]) break;
        const move = gen.moves.get(toID(f[2] || '') as any);
        if (!move) break;
        const s = slots[slot];
        if (abilityMayAlterPriority(gen, s.setKey, move as unknown as { category: string; type: string; flags?: { heal?: number } })) {
          procTainted = true;
        }
        actions.push({
          slot, side: s.side, setKey: s.setKey, priority: move.priority,
          boosts: { ...s.boosts }, status: s.status, tera: s.tera,
        });
        break;
      }
      default:
        break;
    }
  }
  flushTurn();
  return out;
}
