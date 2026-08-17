// Shared domain types for the Team-Scouter tool.

export type StatID = 'hp' | 'atk' | 'def' | 'spa' | 'spd' | 'spe';

export type StatsTable = { [K in StatID]: number };

/** A normalized replay pulled from replay.pokemonshowdown.com. */
export interface Replay {
  id: string;
  url: string;
  format: string; // e.g. "[Gen 8] UU"
  formatid: string; // e.g. "gen8uu"
  gen: number; // 1-9
  players: string[]; // [p1name, p2name]
  log: string;
  uploadtime: number; // unix seconds
  winner?: string;
}

/** What the replay log actually revealed about one Pokemon. */
export interface RevealedMon {
  player: string; // trainer name
  side: 'p1' | 'p2';
  species: string; // display species as seen (e.g. "Zarude-Dada")
  baseSpecies: string; // set/learnset key (e.g. "Zarude")
  nickname?: string;
  gender?: 'M' | 'F' | 'N';
  level: number; // defaults 100
  shiny: boolean;
  moves: string[]; // revealed move display names, dedup, in reveal order
  item?: string; // last known item name
  itemHistory: string[]; // all item names seen (knock off / trick etc.)
  ability?: string; // revealed ability
  tera?: string; // revealed tera type (gen 9)
  fainted: boolean;
  appeared: boolean; // switched into battle at least once (vs team-preview only)
  usedMultipleMoves: boolean; // used 2+ distinct moves in one stay-in -> not Choice-locked
  /** Observed Stealth Rock / Spikes damage, or a Toxic Spikes poison, at least
   *  once -> proves this mon can NOT be holding Heavy-Duty Boots (it blocks all
   *  three). A hard veto against ever guessing Boots for this mon. */
  tookHazardDamage: boolean;
}

/** One player's revealed team from a replay. */
export interface RevealedTeam {
  player: string;
  side: 'p1' | 'p2';
  mons: RevealedMon[];
}

/** A Smogon dex analysis set (as stored in sets/{formatid}.json). */
export interface DexSet {
  role?: string; // the set name, e.g. "Bulky Attacker"
  movepool: string[]; // flattened possible moves (slot alternatives unioned)
  moves: (string | string[])[]; // raw, slot alternatives preserved
  ability?: string | string[];
  item?: string | string[];
  nature?: string | string[];
  teratypes?: string | string[];
  evs?: Partial<StatsTable>;
  ivs?: Partial<StatsTable>;
  level?: number;
  /** True for a manually-pinned, human-verified build (see `scout pin`) — the
   *  moveset/Tera guessing thresholds that guard probabilistic dex/usage/
   *  history candidates don't apply, since this isn't a guess. */
  verified?: boolean;
}

/** The tool's best guess of a full set for one Pokemon. */
export interface MatchedSet {
  species: string;
  baseSpecies: string;
  nickname?: string;
  gender?: 'M' | 'F' | 'N';
  level: number;
  shiny: boolean;
  matchedRole?: string; // which dex set name we matched, if any
  moves: string[]; // final 4 (or fewer) moves
  revealedMoves: string[]; // subset that was actually observed
  item?: string;
  itemRevealed: boolean; // true only if the item was actually shown in the replay
  ability?: string;
  nature: string;
  evs: Partial<StatsTable>;
  ivs?: Partial<StatsTable>;
  tera?: string;
  confidence: number; // 0..1
  notes: string[]; // human-readable provenance
  evSource: 'dex-set' | 'derived' | 'default';
  /** True if the mon revealed nothing in the replay (no move/item/ability/tera).
   *  Such sets are left empty rather than guessed — there is nothing to infer. */
  unrevealed?: boolean;
  /** False when the mon provably can't hold a Choice item (used 2+ moves in one
   *  stay-in). The item search never proposes a Choice item for these. */
  choicePossible?: boolean;
  /** Minimum Speed EVs consistent with every observed turn-order fact for this
   *  mon (undefined if no speed evidence exists). A hard floor: bulk/offense
   *  passes may sacrifice Speed for other stats, but never below this. */
  speedFloor?: number;
}

/** A damage observation extracted from the log, used by the EV engine. */
export interface DamageObservation {
  turn: number;
  attackerSide: 'p1' | 'p2';
  attackerSpecies: string;
  defenderSide: 'p1' | 'p2';
  defenderSpecies: string;
  move: string;
  observedPercent: number; // percent of max HP dealt (0..100)
  koCapped: boolean; // hit fainted the defender -> observed is a LOWER bound
  field: FieldSnapshot;
  crit: boolean;
  usable: boolean; // false if crit / multi-hit / substitute / roll-ambiguous
  reason?: string; // why unusable
}

/**
 * A same-priority-bracket turn where both sides acted, proving one mon's
 * effective Speed exceeded the other's at that moment (order was NOT decided
 * by priority, Quick Claw/Custap/Quick Draw, etc. — those turns are excluded
 * at extraction time). The only direct Speed evidence a replay offers.
 */
export interface SpeedObservation {
  turn: number;
  fasterSide: 'p1' | 'p2';
  fasterSpecies: string;
  slowerSide: 'p1' | 'p2';
  slowerSpecies: string;
  fasterBoosts: Partial<StatsTable>;
  slowerBoosts: Partial<StatsTable>;
  fasterStatus?: string;
  slowerStatus?: string;
  fasterTera?: string;
  slowerTera?: string;
  trickRoom: boolean; // if true, order is REVERSED (slower-speed mon acted first)
}

/** Field / battle conditions captured at the moment of a hit. */
export interface FieldSnapshot {
  weather?: string;
  terrain?: string;
  attackerBoosts: Partial<StatsTable>;
  defenderBoosts: Partial<StatsTable>;
  attackerStatus?: string;
  defenderStatus?: string;
  attackerItem?: string;
  defenderItem?: string;
  attackerAbility?: string;
  defenderAbility?: string;
  reflect: boolean;
  lightScreen: boolean;
  auroraVeil: boolean;
  attackerHpPercent: number;
  defenderHpPercent: number;
  attackerTera?: string;
  defenderTera?: string;
}

/** A fully scouted team ready to export. */
export interface ScoutedTeam {
  player: string;
  side: 'p1' | 'p2';
  sets: MatchedSet[];
  paste: string; // full importable team text
}

/** Result of scouting one replay. */
export interface ScoutedReplay {
  replay: Replay;
  teams: ScoutedTeam[];
  scoutedAt: number;
}
