// Per-format teambuilding rules for the counter-team builder: which
// species are mandatory, what coverage every team must carry, and where
// "is this actually a good Pokemon in this tier" comes from. Different
// tiers genuinely need different answers to all three — gen9ubers and
// gen9nationaldexubers don't share a metagame, a banlist, or even the same
// notion of "viable."
import type { Generation } from '@pkmn/data';
import type { MatchedSet } from '../types.js';
import { toID, speciesMeta } from '../data/dex.js';
import { VR_TIER_SCORE, type VrTier } from './vr-thread.js';
import { GEN9_NATDEX_UBERS_BUNDLED_VR } from './tiers/gen9nationaldexubers-bundled-vr.js';

export interface RequirementCandidate {
  species: string;
  set: MatchedSet;
}

export interface Requirement {
  label: string;
  satisfies: (gen: Generation, pick: RequirementCandidate) => boolean;
  /** The Tera type that would satisfy this requirement, set only when this
   *  IS a type-or-Tera requirement (allowTera true) — lets the repair pass
   *  (see enforceRequirements in team-builder.ts) prefer reassigning an
   *  already-strong team member's Tera over swapping in a whole different,
   *  likely lower-tier species that happens to carry the type naturally.
   *  Left unset for a natural-type-only requirement (e.g. Steel, Fairy),
   *  where an actual Pokemon of that type is required — Tera can't stand
   *  in for it. */
  teraType?: string;
}

function typeRequirement(type: string, allowTera: boolean): Requirement {
  return {
    label: allowTera ? `${type} coverage (type or Tera)` : `${type} type`,
    satisfies: (gen, pick) => {
      const meta = speciesMeta(gen, pick.set.baseSpecies);
      const types = (meta?.types ?? []).map((t) => t.toLowerCase());
      if (types.includes(type.toLowerCase())) return true;
      if (allowTera && (pick.set.tera ?? '').toLowerCase() === type.toLowerCase()) return true;
      return false;
    },
    teraType: allowTera ? type : undefined,
  };
}

/** Satisfied by the type/Tera rule above, OR by fielding one of `altSpecies`
 *  outright regardless of its own typing (e.g. "Dark coverage or Marshadow"
 *  — Marshadow itself is Fighting/Ghost, not Dark, but its presence answers
 *  the same metagame need the requirement is really getting at). */
function typeOrSpeciesRequirement(type: string, allowTera: boolean, altSpecies: string[]): Requirement {
  const base = typeRequirement(type, allowTera);
  const altIds = new Set(altSpecies.map(toID));
  return {
    label: `${base.label} or ${altSpecies.join('/')}`,
    satisfies: (gen, pick) => base.satisfies(gen, pick) || altIds.has(toID(pick.species)),
    teraType: base.teraType,
  };
}

const SPEED_CONTROL_MOVES = new Set(['trickroom', 'tailwind', 'stickyweb', 'thunderwave', 'glare', 'nuzzle', 'icywind']);

/** At least one real speed-control tool: Trick Room (flips the whole speed
 *  order), Tailwind/paralysis/Icy Wind (shifts it), sticky Web (drags the
 *  opponent down), or a Choice Scarf holder (a guaranteed fast responder).
 *  Without any of this a team is purely hoping its own base speed tiers
 *  line up favorably against whatever it's facing. */
function speedControlRequirement(): Requirement {
  return {
    label: 'speed control (Trick Room / Tailwind / paralysis / Sticky Web / Choice Scarf)',
    satisfies: (_gen, pick) => {
      const moves = pick.set.moves.map(toID);
      if (moves.some((m) => SPEED_CONTROL_MOVES.has(m))) return true;
      return toID(pick.set.item || '').startsWith('choicescarf');
    },
  };
}

export interface ViabilityResult {
  passes: boolean; // clears this tier's "actually worth recommending" bar
  score: number; // feeds directly into qualityScore
  label: string; // shown in the pick's rationale
}

export interface ViabilityContext {
  usageRanks: Map<string, number>; // toID(species) -> 1-indexed real-usage rank
  /** The current tier's live-fetched Viability Rankings list (see
   *  vr-thread.ts), re-fetched fresh for every buildCounterTeam call — null
   *  if this tier has no VR thread configured, or the fetch/parse failed. */
  vrMap: Record<string, VrTier> | null;
}

// Usage% is heavily right-skewed (staples at 20-90%, everything else falls
// off a cliff under ~10%) — scoring by how far inside the cutoff a candidate
// sits, rather than the raw percent, gives a steep, decisive gradient that
// favors genuine staples long before matchup differences could outweigh it.
function usageRankViability(maxRank: number, weight: number) {
  return (species: string, ctx: ViabilityContext): ViabilityResult => {
    const rank = ctx.usageRanks.get(toID(species));
    if (rank !== undefined && rank <= maxRank) {
      return { passes: true, score: (maxRank - rank + 1) * weight, label: `#${rank} in real usage for this tier` };
    }
    return { passes: false, score: 0, label: 'not ranked in top real usage for this tier' };
  };
}

// A curated community Viability Rankings list IS the "is this good" signal
// for tiers small/specific enough to have one — more authoritative than raw
// usage%, which conflates "good" with "merely popular" or "usage-stat noise"
// (see candidate-pool.ts's dex-analysis-over-usage-stats preference for the
// same principle applied to sets). D rank ("unviable, but legal by tiering")
// does not pass — being on the tier's own banlist-adjacent bottom shelf is
// exactly what this is meant to filter out. Reads ctx.vrMap rather than a
// closed-over static map, since it's fetched fresh per buildCounterTeam call
// (see vr-thread.ts) — a species missing from a fetch that failed entirely
// (vrMap null) correctly fails here too, same as one genuinely unlisted.
function vrListViability(weight: number) {
  return (species: string, ctx: ViabilityContext): ViabilityResult => {
    if (!ctx.vrMap) return { passes: false, score: 0, label: 'Viability Rankings unavailable (fetch failed)' };
    // toID-normalized lookup, not a direct key match — candidateSpecies can
    // carry whatever exact casing/hyphenation its own source (local store,
    // Smogon usage stats) used, which won't always match the VR thread's.
    const tier = Object.entries(ctx.vrMap).find(([k]) => toID(k) === toID(species))?.[1];
    if (!tier) return { passes: false, score: 0, label: 'not on the Viability Rankings list' };
    const score = VR_TIER_SCORE[tier];
    return { passes: score > 0, score: score * weight, label: `${tier} rank on the Viability Rankings` };
  };
}

export interface TierConfig {
  mandatorySpecies: string[];
  requirements: Requirement[];
  /** Species to always include in the candidate pool alongside whatever
   *  allCandidateSpecies() already finds (locally-scouted + Smogon usage-
   *  tracked). Ignored for a VR-driven tier (vrThreadUrl set) — there, the
   *  live-fetched VR list itself IS the entire candidate pool; see
   *  buildCounterTeam in team-builder.ts. */
  extraCandidateSpecies: string[];
  getViability: (species: string, ctx: ViabilityContext) => ViabilityResult;
  /** Skip team-builder.ts's own AG/Illegal/CAP/isNonstandard legality check
   *  for this tier. That check reads @pkmn/dex's CURRENT-gen species table,
   *  which only carries the regional dex (~874 species) — a National-Dex-
   *  only species like Marshadow has no meaningful tier/isNonstandard data
   *  there to check in the first place (speciesMeta()'s ungenned fallback
   *  that DOES resolve it always reports isNonstandard: "Past", which would
   *  wrongly exclude every one of them if checked). For a VR-list-driven
   *  tier, membership on that curated list already implies "legal and worth
   *  using" for this format, so the dex-table check is skipped entirely
   *  rather than producing false negatives. */
  trustCuratedLegality?: boolean;
  /** The tier's Viability Rankings thread — when set, buildCounterTeam
   *  fetches it fresh (see vr-thread.ts) at the start of every call and
   *  restricts the ENTIRE candidate pool to species that list ranks as
   *  viable (non-D). Nothing outside that list is usable, no matter how
   *  common it is locally or in Smogon's usage stats — the VR council's
   *  current judgment is the authority for this kind of tier, not raw
   *  popularity. */
  vrThreadUrl?: string;
  /** Last-resort fallback for a VR-driven tier: a real snapshot shipped
   *  WITH the app, used only when BOTH the live fetch AND the on-disk
   *  last-known-good copy (see vr-thread.ts) come up empty — in practice,
   *  a deployment whose outbound IP is blocked by Smogon's forum
   *  bot-protection and has never once completed a live fetch, so there's
   *  no saved copy to fall back to either. Ignored for tiers without a
   *  vrThreadUrl. */
  bundledVrFallback?: Record<string, VrTier>;
}

const GENERIC_CONFIG: TierConfig = {
  mandatorySpecies: [],
  requirements: [speedControlRequirement()],
  extraCandidateSpecies: [],
  getViability: usageRankViability(45, 3),
};

const CONFIGS: Record<string, TierConfig> = {
  gen9ubers: {
    mandatorySpecies: ['Koraidon'],
    requirements: [
      typeRequirement('Steel', false), // an actual Steel-type, not Tera
      typeRequirement('Dark', true),
      typeRequirement('Fairy', true),
      speedControlRequirement(),
    ],
    extraCandidateSpecies: [],
    getViability: usageRankViability(45, 3),
  },
  gen9nationaldexubers: {
    mandatorySpecies: ['Groudon-Primal'],
    requirements: [
      typeRequirement('Steel', false), // an actual Steel-type, not Tera
      typeOrSpeciesRequirement('Dark', true, ['Marshadow']),
      typeRequirement('Poison', true),
      typeRequirement('Fairy', true), // unlike gen9ubers, Fairy can be satisfied via Tera here
      speedControlRequirement(),
    ],
    extraCandidateSpecies: [],
    getViability: vrListViability(8),
    trustCuratedLegality: true,
    vrThreadUrl: 'https://www.smogon.com/forums/threads/national-dex-ubers-viability-rankings-update-12-at-post-377.3712169/',
    bundledVrFallback: GEN9_NATDEX_UBERS_BUNDLED_VR,
  },
};

export function getTierConfig(formatid: string): TierConfig {
  return CONFIGS[formatid] ?? GENERIC_CONFIG;
}
