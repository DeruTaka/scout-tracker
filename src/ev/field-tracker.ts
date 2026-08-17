// Re-walk a battle log while maintaining full field state (weather, terrain,
// screens, boosts, status, substitute, HP, tera) and emit a DamageObservation
// for every clean, EV-informative direct move hit.
import type { Replay, DamageObservation, FieldSnapshot, StatsTable } from '../types.js';
import { getGen, resolveSpecies, toID } from '../data/dex.js';

type Side = 'p1' | 'p2';

// Moves whose damage doesn't depend on the attacker's offensive EVs.
const NON_EV_MOVES = new Set([
  'seismictoss', 'nightshade', 'superfang', 'dragonrage', 'sonicboom',
  'finalgambit', 'endeavor', 'counter', 'mirrorcoat', 'metalburst', 'foulplay',
  'painsplit', 'bide', 'naturesmadness', 'ruination', 'guardianofalola',
  'psywave', 'beatup',
]);

interface SlotState {
  side: Side;
  setKey: string;
  hp: number; // percent 0..100
  boosts: Partial<StatsTable>;
  status?: string;
  subActive: boolean;
  tera?: string;
}

interface Pending {
  atkSlot: string;
  targetSlot: string;
  move: string;
  crit: boolean;
  hits: number;
  /** Focus Sash / Sturdy / Endure clipped this hit to 1 HP — the observed %
   *  reflects the SAVE, not the real damage (which could be far higher), so
   *  it's not just imprecise like a KO-cap, it's genuinely uninformative. */
  survivedAtOne: boolean;
}

function slotKey(token: string): string | null {
  const m = /^(p[12][a-c]):/.exec(token);
  return m ? m[1]! : null;
}
function sideOf(slot: string): Side {
  return slot.slice(0, 2) as Side;
}
function parseHp(field: string | undefined): number | null {
  if (!field) return null;
  if (/\bfnt\b/.test(field) || field.startsWith('0 ')) return 0;
  const m = /^(\d+)\/(\d+)/.exec(field.trim());
  if (!m) return null;
  return (Number(m[1]) / Number(m[2])) * 100;
}
function fields(line: string): string[] {
  return line.slice(1).split('|');
}
function findFrom(parts: string[], kind: string): string | undefined {
  for (const p of parts) {
    const m = new RegExp(`^\\[from\\]\\s*${kind}:?\\s*(.*)$`).exec(p.trim());
    if (m) return (m[1] || '').trim();
  }
  return undefined;
}
function hasTag(parts: string[], tag: string): boolean {
  return parts.some((p) => p.trim().startsWith(`[${tag}]`));
}

const BOOST_STATS: (keyof StatsTable)[] = ['atk', 'def', 'spa', 'spd', 'spe'];

export function extractObservations(replay: Replay): DamageObservation[] {
  const gen = getGen(replay.gen);
  const obs: DamageObservation[] = [];
  const slots: Record<string, SlotState> = {};
  let weather: string | undefined;
  let terrain: string | undefined;
  const screens: Record<Side, { reflect: boolean; lightScreen: boolean; auroraVeil: boolean }> = {
    p1: { reflect: false, lightScreen: false, auroraVeil: false },
    p2: { reflect: false, lightScreen: false, auroraVeil: false },
  };
  let turn = 0;
  let pending: Pending | null = null;

  const setActive = (slot: string, speciesSeen: string, hp: number | null) => {
    const { setKey } = resolveSpecies(gen, speciesSeen);
    slots[slot] = {
      side: sideOf(slot),
      setKey,
      hp: hp ?? 100,
      boosts: {},
      subActive: false,
    };
  };

  const snapshot = (atkSlot: string, defSlot: string): FieldSnapshot => {
    const a = slots[atkSlot]!;
    const d = slots[defSlot]!;
    return {
      weather,
      terrain,
      attackerBoosts: { ...a.boosts },
      defenderBoosts: { ...d.boosts },
      attackerStatus: a.status,
      defenderStatus: d.status,
      reflect: screens[d.side].reflect,
      lightScreen: screens[d.side].lightScreen,
      auroraVeil: screens[d.side].auroraVeil,
      attackerHpPercent: a.hp,
      defenderHpPercent: d.hp,
      attackerTera: a.tera,
      defenderTera: d.tera,
    };
  };

  const finishPending = () => {
    pending = null;
  };

  for (const raw of replay.log.split('\n')) {
    if (!raw.startsWith('|')) continue;
    const f = fields(raw);
    const cmd = f[0];

    switch (cmd) {
      case 'turn':
        turn = Number(f[1]) || turn;
        finishPending();
        break;
      case 'switch':
      case 'drag':
      case 'replace': {
        const slot = slotKey(f[1] || '');
        if (slot) setActive(slot, (f[2] || '').split(',')[0]!.trim(), parseHp(f[3]));
        finishPending();
        break;
      }
      case '-weather':
        weather = f[1] && f[1] !== 'none' ? f[1] : undefined;
        break;
      case '-fieldstart': {
        const eff = (f[1] || '').replace(/^move:\s*/, '');
        if (/Grassy Terrain/i.test(eff)) terrain = 'Grassy';
        else if (/Electric Terrain/i.test(eff)) terrain = 'Electric';
        else if (/Psychic Terrain/i.test(eff)) terrain = 'Psychic';
        else if (/Misty Terrain/i.test(eff)) terrain = 'Misty';
        break;
      }
      case '-fieldend': {
        const eff = f[1] || '';
        if (/Terrain/i.test(eff)) terrain = undefined;
        break;
      }
      case '-sidestart': {
        const side = (f[1] || '').slice(0, 2) as Side;
        const eff = (f[2] || '').replace(/^move:\s*/, '');
        if (screens[side]) {
          if (/Reflect/i.test(eff)) screens[side].reflect = true;
          else if (/Light Screen/i.test(eff)) screens[side].lightScreen = true;
          else if (/Aurora Veil/i.test(eff)) screens[side].auroraVeil = true;
        }
        break;
      }
      case '-sideend': {
        const side = (f[1] || '').slice(0, 2) as Side;
        const eff = f[2] || '';
        if (screens[side]) {
          if (/Reflect/i.test(eff)) screens[side].reflect = false;
          else if (/Light Screen/i.test(eff)) screens[side].lightScreen = false;
          else if (/Aurora Veil/i.test(eff)) screens[side].auroraVeil = false;
        }
        break;
      }
      case '-boost':
      case '-unboost': {
        const slot = slotKey(f[1] || '');
        const stat = f[2] as keyof StatsTable;
        const amt = (Number(f[3]) || 0) * (cmd === '-unboost' ? -1 : 1);
        if (slot && slots[slot] && BOOST_STATS.includes(stat)) {
          slots[slot].boosts[stat] = (slots[slot].boosts[stat] || 0) + amt;
        }
        break;
      }
      case '-setboost': {
        const slot = slotKey(f[1] || '');
        const stat = f[2] as keyof StatsTable;
        if (slot && slots[slot] && BOOST_STATS.includes(stat)) {
          slots[slot].boosts[stat] = Number(f[3]) || 0;
        }
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
      case '-start': {
        const slot = slotKey(f[1] || '');
        if (slot && slots[slot] && /Substitute/i.test(f[2] || '')) slots[slot].subActive = true;
        break;
      }
      case '-end': {
        const slot = slotKey(f[1] || '');
        if (slot && slots[slot] && /Substitute/i.test(f[2] || '')) slots[slot].subActive = false;
        break;
      }
      case '-terastallize': {
        const slot = slotKey(f[1] || '');
        if (slot && slots[slot]) slots[slot].tera = f[2];
        break;
      }
      case 'move': {
        const atkSlot = slotKey(f[1] || '');
        const move = f[2] || '';
        const targetSlot = slotKey(f[3] || '');
        finishPending();
        if (atkSlot && targetSlot && slots[atkSlot] && slots[targetSlot] && atkSlot !== targetSlot) {
          pending = { atkSlot, targetSlot, move, crit: false, hits: 0, survivedAtOne: false };
        }
        break;
      }
      case '-crit': {
        const slot = slotKey(f[1] || '');
        if (pending && slot === pending.targetSlot) pending.crit = true;
        break;
      }
      case '-hitcount': {
        if (pending) pending.hits = Number(f[2]) || 2;
        break;
      }
      case '-enditem': {
        const slot = slotKey(f[1] || '');
        if (pending && slot === pending.targetSlot && /focus sash/i.test(f[2] || '')) pending.survivedAtOne = true;
        break;
      }
      case '-activate': {
        const slot = slotKey(f[1] || '');
        const eff = f[2] || '';
        if (pending && slot === pending.targetSlot && (/ability:\s*sturdy/i.test(eff) || /move:\s*endure/i.test(eff))) {
          pending.survivedAtOne = true;
        }
        break;
      }
      case '-miss':
      case '-fail':
      case '-immune':
        finishPending();
        break;
      case '-heal': {
        const slot = slotKey(f[1] || '');
        const hp = parseHp(f[2]);
        if (slot && slots[slot] && hp !== null) slots[slot].hp = hp;
        break;
      }
      case '-sethp': {
        const slot = slotKey(f[1] || '');
        const hp = parseHp(f[2]);
        if (slot && slots[slot] && hp !== null) slots[slot].hp = hp;
        break;
      }
      case '-damage': {
        const slot = slotKey(f[1] || '');
        const newHp = parseHp(f[2]);
        if (!slot || !slots[slot] || newHp === null) break;
        const isDirectMoveHit =
          pending &&
          slot === pending.targetSlot &&
          !findFrom(f, 'item') &&
          !findFrom(f, 'ability') &&
          !hasTag(f, 'from'); // recoil / hazards / status carry [from]
        if (isDirectMoveHit) {
          const p = pending!;
          p.hits += 1;
          const before = slots[slot].hp;
          const dealt = Math.max(0, before - newHp);
          const moveId = toID(p.move);
          const usable =
            p.hits === 1 &&
            !p.crit &&
            !slots[slot].subActive &&
            !NON_EV_MOVES.has(moveId) &&
            dealt > 0 &&
            !p.survivedAtOne;
          const a = slots[p.atkSlot]!;
          obs.push({
            turn,
            attackerSide: a.side,
            attackerSpecies: a.setKey,
            defenderSide: slots[slot].side,
            defenderSpecies: slots[slot].setKey,
            move: p.move,
            observedPercent: dealt,
            koCapped: newHp === 0,
            field: snapshot(p.atkSlot, slot),
            crit: p.crit,
            usable,
            reason: !usable
              ? p.crit
                ? 'crit'
                : p.hits > 1
                  ? 'multi-hit'
                  : slots[slot].subActive
                    ? 'substitute'
                    : NON_EV_MOVES.has(moveId)
                      ? 'fixed/redirected damage'
                      : p.survivedAtOne
                        ? 'focus sash / sturdy / endure (clipped to 1 HP, true damage unknown)'
                        : 'zero damage'
              : undefined,
          });
          slots[slot].hp = newHp;
          // keep pending in case of multi-hit; the next -damage marks it multi
        } else {
          slots[slot].hp = newHp;
        }
        break;
      }
      case 'faint': {
        const slot = slotKey(f[1] || '');
        if (slot && slots[slot]) slots[slot].hp = 0;
        break;
      }
      case 'upkeep':
        finishPending();
        break;
      default:
        break;
    }
  }
  return obs;
}
