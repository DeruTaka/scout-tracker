// Parse a Showdown battle log into each player's revealed team: full roster
// (team preview) plus every move / item / ability / tera revealed in play.
import type { Replay, RevealedMon, RevealedTeam } from '../types.js';
import { getGen, resolveSpecies, moveName, itemName, abilityName, toID } from '../data/dex.js';
import type { Generation } from '@pkmn/data';

// Moves that CALL another move: the resulting |move| is not part of the user's
// own 4-move set (except Sleep Talk, which picks a real set move).
const CALLER_MOVES = new Set([
  'metronome', 'assist', 'copycat', 'naturepower', 'mefirst', 'mirrormove',
  'magicbounce', 'magiccoat', 'snatch', 'sleeptalk',
]);
const CALLER_KEEP = new Set(['sleeptalk']); // reveals a genuine set move

interface Details {
  species: string;
  gender?: 'M' | 'F' | 'N';
  level: number;
  shiny: boolean;
}

function parseDetails(details: string): Details {
  const parts = details.split(',').map((s) => s.trim());
  const species = parts[0] || '';
  let gender: Details['gender'];
  let level = 100;
  let shiny = false;
  for (const p of parts.slice(1)) {
    if (p === 'M' || p === 'F' || p === 'N') gender = p;
    else if (p === 'shiny') shiny = true;
    else if (/^L\d+$/.test(p)) level = Number(p.slice(1));
  }
  return { species, gender, level, shiny };
}

interface SlotRef {
  side: 'p1' | 'p2';
  setKey: string;
}

function parsePokeName(token: string): { side: 'p1' | 'p2'; nickname: string } | null {
  // token like "p1a: Nidoqueen"
  const m = /^(p[12])[a-c]: (.+)$/.exec(token);
  if (!m) return null;
  return { side: m[1] as 'p1' | 'p2', nickname: m[2]! };
}

function slotId(token: string): string | null {
  const m = /^(p[12][a-c]):/.exec(token);
  return m ? m[1]! : null;
}

/** Split a log line into "|"-delimited fields (leading | already stripped). */
function fields(line: string): string[] {
  return line.slice(1).split('|');
}

function findFrom(parts: string[], kind: 'item' | 'ability' | 'move'): string | undefined {
  for (const p of parts) {
    const t = p.trim();
    const m = new RegExp(`^\\[from\\]\\s*${kind}:\\s*(.+)$`).exec(t);
    if (m) return m[1]!.trim();
  }
  return undefined;
}

function findOf(parts: string[]): string | undefined {
  for (const p of parts) {
    const t = p.trim();
    if (t.startsWith('[of]')) return t.slice(4).trim();
  }
  return undefined;
}

export function parseReplay(replay: Replay): RevealedTeam[] {
  const gen = getGen(replay.gen);
  const [p1name, p2name] = replay.players;

  // per-side roster keyed by resolved set-key species
  const rosters: Record<'p1' | 'p2', Map<string, RevealedMon>> = {
    p1: new Map(),
    p2: new Map(),
  };
  const active: Record<string, SlotRef> = {}; // slotId -> ref

  const nameOf = (side: 'p1' | 'p2') => (side === 'p1' ? p1name : p2name);

  function ensureMon(side: 'p1' | 'p2', speciesSeen: string, det?: Partial<Details> & { nickname?: string }): RevealedMon {
    const { display, setKey } = resolveSpecies(gen, speciesSeen);
    let mon = rosters[side].get(setKey);
    if (!mon) {
      mon = {
        player: nameOf(side)!,
        side,
        species: display,
        baseSpecies: setKey,
        level: det?.level ?? 100,
        shiny: det?.shiny ?? false,
        moves: [],
        itemHistory: [],
        fainted: false,
      };
      rosters[side].set(setKey, mon);
    }
    // Prefer the most specific (forme) display we ever see.
    if (display && display.includes('-') && !mon.species.includes('-')) mon.species = display;
    if (det?.gender && !mon.gender) mon.gender = det.gender;
    if (det?.nickname && det.nickname !== display) mon.nickname = det.nickname;
    if (det?.level) mon.level = det.level;
    if (det?.shiny) mon.shiny = true;
    return mon;
  }

  function monAt(slot: string): RevealedMon | undefined {
    const ref = active[slot];
    if (!ref) return undefined;
    return rosters[ref.side].get(ref.setKey);
  }

  const lines = replay.log.split('\n');
  for (const raw of lines) {
    if (!raw.startsWith('|')) continue;
    const f = fields(raw);
    const cmd = f[0];

    // Generic ability reveal: any line carrying "[from] ability: X" attributes
    // that ability to its "[of] SLOT" owner, or else to the line's own subject.
    // Covers Grassy Surge (-fieldstart), Intimidate (-unboost), Drought
    // (-weather), Levitate (-immune), Stance Change (-formechange), etc.
    const lineAbility = findFrom(f, 'ability');
    if (lineAbility) {
      const ofTok = findOf(f);
      const ownerSlot = ofTok ? slotId(ofTok) : slotId(f[1] || '');
      const owner = ownerSlot ? monAt(ownerSlot) : undefined;
      if (owner) owner.ability = abilityName(gen, lineAbility);
    }

    switch (cmd) {
      case 'poke': {
        // |poke|p1|Species, gender|item
        const side = f[1] as 'p1' | 'p2';
        if (side !== 'p1' && side !== 'p2') break;
        const det = parseDetails(f[2] || '');
        ensureMon(side, det.species, det);
        break;
      }
      case 'switch':
      case 'drag':
      case 'replace': {
        // |switch|p1a: Nick|Species, gender|hp
        const who = parsePokeName(f[1] || '');
        const sid = slotId(f[1] || '');
        if (!who || !sid) break;
        const det = parseDetails(f[2] || '');
        const mon = ensureMon(who.side, det.species, { ...det, nickname: who.nickname });
        active[sid] = { side: who.side, setKey: mon.baseSpecies };
        break;
      }
      case 'move': {
        // |move|p1a: Nick|MoveName|target|[from]move: X ...
        const sid = slotId(f[1] || '');
        if (!sid) break;
        const mon = monAt(sid);
        if (!mon) break;
        const rawMove = f[2] || '';
        const from = findFrom(f, 'move');
        if (from) {
          const fromId = toID(from);
          if (CALLER_MOVES.has(fromId) && !CALLER_KEEP.has(fromId)) break; // called move
          if (CALLER_KEEP.has(fromId)) {
            // the *displayed* move is the real set move for Sleep Talk
          } else if (fromId !== toID(rawMove)) {
            // some other [from]move (e.g. lockedmove) -> still a real move
          }
        }
        addMove(gen, mon, rawMove);
        break;
      }
      case '-terastallize': {
        const sid = slotId(f[1] || '');
        if (!sid) break;
        const mon = monAt(sid);
        if (mon && f[2]) mon.tera = f[2];
        break;
      }
      case '-mega': {
        // |-mega|p1a: X|BaseSpecies|Mega Stone  -> item revealed
        const sid = slotId(f[1] || '');
        const mon = sid ? monAt(sid) : undefined;
        if (mon && f[3]) setItem(gen, mon, f[3]);
        break;
      }
      case '-item': {
        const sid = slotId(f[1] || '');
        const mon = sid ? monAt(sid) : undefined;
        if (mon && f[2]) setItem(gen, mon, f[2]);
        // [of] reveals another mon's ability sometimes (Frisk holder is target)
        break;
      }
      case '-enditem': {
        const sid = slotId(f[1] || '');
        const mon = sid ? monAt(sid) : undefined;
        if (mon && f[2]) setItem(gen, mon, f[2]);
        break;
      }
      case '-ability': {
        // |-ability|p1a: X|Ability|...  (direct reveal; [from]/[of] handled above)
        const sid = slotId(f[1] || '');
        const mon = sid ? monAt(sid) : undefined;
        if (mon && f[2]) mon.ability = abilityName(gen, f[2]);
        break;
      }
      case '-activate': {
        // |-activate|p1a: X|ability: Y  or  |-activate|p1a: X|item: Z
        const sid = slotId(f[1] || '');
        const mon = sid ? monAt(sid) : undefined;
        const effect = f[2] || '';
        if (mon) {
          const am = /^ability:\s*(.+)$/.exec(effect);
          const im = /^item:\s*(.+)$/.exec(effect);
          if (am) mon.ability = abilityName(gen, am[1]!);
          if (im) setItem(gen, mon, im[1]!);
        }
        break;
      }
      case '-heal':
      case '-damage': {
        // pick up "[from] item: X" for the line's subject (ability handled above)
        const sid = slotId(f[1] || '');
        const mon = sid ? monAt(sid) : undefined;
        const fromItem = findFrom(f, 'item');
        if (fromItem && mon) setItem(gen, mon, fromItem);
        break;
      }
      case 'faint': {
        const sid = slotId(f[1] || '');
        const mon = sid ? monAt(sid) : undefined;
        if (mon) mon.fainted = true;
        break;
      }
      default:
        break;
    }
  }

  const teams: RevealedTeam[] = (['p1', 'p2'] as const).map((side) => ({
    player: nameOf(side)!,
    side,
    mons: [...rosters[side].values()],
  }));
  return teams;
}

function addMove(gen: Generation, mon: RevealedMon, rawMove: string): void {
  if (!rawMove) return;
  const name = moveName(gen, rawMove);
  if (name === 'Struggle') return;
  if (!mon.moves.some((m) => toID(m) === toID(name))) {
    if (mon.moves.length < 8) mon.moves.push(name); // keep extras for legality triage
  }
}

function setItem(gen: Generation, mon: RevealedMon, rawItem: string): void {
  const name = itemName(gen, rawItem);
  if (!name) return;
  mon.item = name;
  if (!mon.itemHistory.some((i) => toID(i) === toID(name))) mon.itemHistory.push(name);
}
