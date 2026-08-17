// Parse a Showdown battle log into each player's revealed team: full roster
// (team preview) plus every move / item / ability / tera revealed in play.
import type { Replay, RevealedMon, RevealedTeam } from '../types.js';
import { getGen, resolveSpecies, familyKey, isForme, moveName, itemName, abilityName, toID } from '../data/dex.js';
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
  fam: string;
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

/** The raw value after "[from]" (any effect kind), e.g. "Stealth Rock", "item: Leftovers". */
function findFromAny(parts: string[]): string | undefined {
  for (const p of parts) {
    const m = /^\[from\]\s*(.+)$/.exec(p.trim());
    if (m) return m[1]!.trim();
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
  const stintMoves: Record<string, Set<string>> = {}; // slotId -> distinct move ids used since last switch-in

  // Entry-hazard state per side, for Heavy-Duty Boots inference.
  const hazards: Record<'p1' | 'p2', { sr: boolean; spikes: number; tspikes: number }> = {
    p1: { sr: false, spikes: 0, tspikes: 0 },
    p2: { sr: false, spikes: 0, tspikes: 0 },
  };
  interface HazardFlags {
    enteredSR: boolean; enteredSpikes: boolean; enteredTSpikes: boolean;
    tookSR: boolean; tookSpikes: boolean; tookTSpikes: boolean;
  }
  const hz = new Map<RevealedMon, HazardFlags>();
  const getHz = (mon: RevealedMon): HazardFlags => {
    let h = hz.get(mon);
    if (!h) { h = { enteredSR: false, enteredSpikes: false, enteredTSpikes: false, tookSR: false, tookSpikes: false, tookTSpikes: false }; hz.set(mon, h); }
    return h;
  };
  const speciesTypes = (setKey: string): string[] => {
    const sp = gen.species.get(toID(setKey) as any);
    return sp?.types ? [...sp.types] : [];
  };
  // Grounded = takes ground-based hazards (Spikes / Toxic Spikes). Flying types
  // and Levitate float; Stealth Rock ignores this and hits everyone. When the
  // ability isn't revealed but the species CAN have Levitate, stay conservative
  // and treat it as floating so we don't misread a Levitate dodge as Boots.
  const canLevitate = (setKey: string): boolean => {
    const sp = gen.species.get(toID(setKey) as any);
    return sp?.abilities ? Object.values(sp.abilities).map((a) => toID(a as string)).includes('levitate') : false;
  };
  const isGrounded = (mon: RevealedMon): boolean => {
    if (speciesTypes(mon.baseSpecies).includes('Flying')) return false;
    const ab = toID(mon.ability || '');
    if (ab === 'levitate') return false;
    if (!ab && canLevitate(mon.baseSpecies)) return false;
    return true;
  };

  const nameOf = (side: 'p1' | 'p2') => (side === 'p1' ? p1name : p2name);

  function ensureMon(side: 'p1' | 'p2', speciesSeen: string, det?: Partial<Details> & { nickname?: string }): RevealedMon {
    // Group by species family so a preview placeholder ("Zacian-*") and its
    // revealed forme ("Zacian-Crowned") share one roster slot.
    const fam = familyKey(gen, speciesSeen);
    const r = resolveSpecies(gen, speciesSeen);
    let mon = rosters[side].get(fam);
    if (!mon) {
      mon = {
        player: nameOf(side)!,
        side,
        species: r.display,
        baseSpecies: r.setKey,
        level: det?.level ?? 100,
        shiny: det?.shiny ?? false,
        moves: [],
        itemHistory: [],
        fainted: false,
        appeared: false,
        usedMultipleMoves: false,
        tookHazardDamage: false,
      };
      rosters[side].set(fam, mon);
    }
    if (isForme(gen, r.setKey)) {
      // A specific forme was revealed (e.g. Zacian-Crowned): adopt it as the
      // data key + display, and apply its locked item (Rusted Sword).
      mon.baseSpecies = r.setKey;
      mon.species = r.display;
      if (r.forcedItem) setItem(gen, mon, r.forcedItem);
    } else if (r.display.includes('-') && !mon.species.includes('-')) {
      // Cosmetic forme display refinement (Zarude-Dada, Gastrodon-East).
      mon.species = r.display;
    }
    if (det?.gender && !mon.gender) mon.gender = det.gender;
    if (det?.nickname && det.nickname !== r.display) mon.nickname = det.nickname;
    if (det?.level) mon.level = det.level;
    if (det?.shiny) mon.shiny = true;
    return mon;
  }

  function monAt(slot: string): RevealedMon | undefined {
    const ref = active[slot];
    if (!ref) return undefined;
    return rosters[ref.side].get(ref.fam);
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
        mon.appeared = true;
        active[sid] = { side: who.side, fam: familyKey(gen, det.species) };
        stintMoves[sid] = new Set(); // fresh stay-in → Choice lock (if any) resets
        // Record which present hazards this mon is susceptible to on entry.
        const hstate = hazards[who.side];
        if (hstate.sr || hstate.spikes || hstate.tspikes) {
          const h = getHz(mon);
          const grounded = isGrounded(mon);
          const types = speciesTypes(mon.baseSpecies);
          if (hstate.sr) h.enteredSR = true;
          if (hstate.spikes && grounded) h.enteredSpikes = true;
          if (hstate.tspikes && grounded && !types.includes('Poison') && !types.includes('Steel')) h.enteredTSpikes = true;
        }
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
        // A Choice item locks the holder into one move until it switches. If this
        // mon uses a 2nd distinct move in the same stay-in, it can't be Choiced.
        const mvId = toID(moveName(gen, rawMove));
        if (mvId && mvId !== 'struggle') {
          const set = (stintMoves[sid] ??= new Set());
          set.add(mvId);
          if (set.size >= 2) mon.usedMultipleMoves = true;
        }
        break;
      }
      case '-terastallize': {
        const sid = slotId(f[1] || '');
        if (!sid) break;
        const mon = monAt(sid);
        if (mon && f[2]) mon.tera = f[2];
        break;
      }
      case 'detailschange': {
        // Permanent forme change (e.g. Zacian -> Zacian-Crowned if it wasn't
        // already shown at switch). Adopt the revealed forme for the slot.
        const sid = slotId(f[1] || '');
        const ref = sid ? active[sid] : undefined;
        if (ref) {
          const det = parseDetails(f[2] || '');
          ensureMon(ref.side, det.species, det);
        }
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
        const sid = slotId(f[1] || '');
        const mon = sid ? monAt(sid) : undefined;
        // Entry-hazard damage → this mon did NOT dodge it (rules out Boots).
        if (cmd === '-damage' && mon) {
          const eff = toID((findFromAny(f) || '').replace(/^(?:move|item|ability):\s*/i, ''));
          if (eff === 'stealthrock') { getHz(mon).tookSR = true; mon.tookHazardDamage = true; }
          else if (eff === 'spikes') { getHz(mon).tookSpikes = true; mon.tookHazardDamage = true; }
        }
        // "[from] item: X": an item that PROCS on another mon (Rocky Helmet,
        // Jaboca/Rowap Berry) carries an "[of]" holder — the item belongs to the
        // HOLDER, not the mon taking the damage. Only a self-affecting item
        // (Leftovers, Black Sludge, Life Orb recoil) with no [of] is the subject's.
        const fromItem = findFrom(f, 'item');
        if (fromItem) {
          const ofTok = findOf(f);
          if (ofTok) {
            const owner = monAt(slotId(ofTok) || '');
            if (owner) setItem(gen, owner, fromItem);
          } else if (mon) {
            setItem(gen, mon, fromItem);
          }
        }
        break;
      }
      case '-status': {
        // Toxic Spikes poison on entry rules out Boots (approximate: any poison
        // gained while Toxic Spikes sit on the mon's side).
        const sid = slotId(f[1] || '');
        const mon = sid ? monAt(sid) : undefined;
        const st = f[2];
        if (mon && sid && (st === 'psn' || st === 'tox')) {
          const side = active[sid]?.side;
          if (side && hazards[side].tspikes > 0) { getHz(mon).tookTSpikes = true; mon.tookHazardDamage = true; }
        }
        break;
      }
      case '-sidestart': {
        const side = /^(p[12])/.exec(f[1] || '')?.[1] as 'p1' | 'p2' | undefined;
        const eff = toID((f[2] || '').replace(/^move:\s*/i, ''));
        if (side) {
          if (eff === 'stealthrock') hazards[side].sr = true;
          else if (eff === 'spikes') hazards[side].spikes++;
          else if (eff === 'toxicspikes') hazards[side].tspikes++;
        }
        break;
      }
      case '-sideend': {
        const side = /^(p[12])/.exec(f[1] || '')?.[1] as 'p1' | 'p2' | undefined;
        const eff = toID((f[2] || '').replace(/^move:\s*/i, ''));
        if (side) {
          if (eff === 'stealthrock') hazards[side].sr = false;
          else if (eff === 'spikes') hazards[side].spikes = 0;
          else if (eff === 'toxicspikes') hazards[side].tspikes = 0;
        }
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

  // Heavy-Duty Boots: a mon that switched into a hazard it was susceptible to
  // but took no damage / poison from it must have been ignoring hazards. (Magic
  // Guard also ignores them, so skip those; and never override a revealed item.)
  for (const side of ['p1', 'p2'] as const) {
    for (const mon of rosters[side].values()) {
      if (mon.item || toID(mon.ability || '') === 'magicguard') continue;
      const h = hz.get(mon);
      if (!h) continue;
      const dodgedHazard =
        (h.enteredSR && !h.tookSR) ||
        (h.enteredSpikes && !h.tookSpikes) ||
        (h.enteredTSpikes && !h.tookTSpikes);
      if (dodgedHazard) setItem(gen, mon, 'Heavy-Duty Boots');
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
