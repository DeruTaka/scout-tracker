// Live fetch + parse of a Smogon Viability Rankings thread's first post —
// used instead of a hand-maintained static list so a tier's usable-Pokemon
// set always reflects whatever the council currently has posted, not a
// snapshot that silently drifts out of date. Re-fetched on every
// buildCounterTeam call for a VR-driven tier (see team-builder.ts) — one
// HTTP GET + string parsing per call, not per-candidate, so the cost is
// negligible next to everything else a counter-team build already does.
import type { Generation } from '@pkmn/data';
import { speciesMeta } from '../data/dex.js';

export type VrTier = 'S+' | 'S' | 'S-' | 'A+' | 'A' | 'A-' | 'B+' | 'B' | 'B-' | 'C+' | 'C' | 'C-' | 'D';
const TIER_LABELS: readonly VrTier[] = ['S+', 'S', 'S-', 'A+', 'A', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'C-', 'D'];

export const VR_TIER_SCORE: Record<VrTier, number> = {
  'S+': 13, S: 12, 'S-': 11,
  'A+': 10, A: 9, 'A-': 8,
  'B+': 7, B: 6, 'B-': 5,
  'C+': 4, C: 3, 'C-': 2,
  D: 0,
};

// The thread's own abbreviations/forme shorthand for anything speciesMeta()
// can't resolve as-is — e.g. "Zacian-C" for Zacian-Crowned, "Primal
// Groudon" for Groudon-Primal. Hand-maintained, but this is shorthand
// convention, not ranking data, so it doesn't go stale the way a hardcoded
// tier list would — the council doesn't rename Pokemon.
const NAME_ALIASES: Record<string, string> = {
  'Primal Groudon': 'Groudon-Primal',
  'Primal Kyogre': 'Kyogre-Primal',
  'Zacian-C': 'Zacian-Crowned',
  'Zamazenta-C': 'Zamazenta-Crowned',
  'Zygarde-C': 'Zygarde-Complete',
  'Necrozma-DM': 'Necrozma-Dusk-Mane',
  'Necrozma-DW': 'Necrozma-Dawn-Wings',
  'Ultra Necrozma': 'Necrozma-Ultra',
  'Mega Salamence': 'Salamence-Mega',
  'Mega Diancie': 'Diancie-Mega',
  'Mega Mewtwo Y': 'Mewtwo-Mega-Y',
  'Mega Mewtwo X': 'Mewtwo-Mega-X',
  'Mega Alakazam': 'Alakazam-Mega',
  'Mega Blastoise': 'Blastoise-Mega',
  'Mega Blaziken': 'Blaziken-Mega',
  'Mega Kangaskhan': 'Kangaskhan-Mega',
  'Mega Lucario': 'Lucario-Mega',
  'Mega Metagross': 'Metagross-Mega',
  'Mega Tyranitar': 'Tyranitar-Mega',
  'Deoxys-A': 'Deoxys-Attack',
  'Deoxys-S': 'Deoxys-Speed',
  'Giratina-O': 'Giratina-Origin',
  'Palkia-O': 'Palkia-Origin',
  'Dialga-O': 'Dialga-Origin',
  'Kyurem-B': 'Kyurem-Black',
  'Kyurem-W': 'Kyurem-White',
  'Landorus-T': 'Landorus-Therian',
  'Basculegion-M': 'Basculegion',
  'Galarian Darmanitan': 'Darmanitan-Galar',
  'Ogerpon-H': 'Ogerpon-Hearthflame',
  'Shaymin-S': 'Shaymin-Sky',
  'Ursaluna-B': 'Ursaluna-Bloodmoon',
  'Calyrex-I': 'Calyrex-Ice',
};

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&#0?39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
}

export interface RawVrEntry {
  tier: VrTier;
  displayName: string;
}

/**
 * Pure parser: given the full thread page's HTML, extract every Pokemon
 * listed under a tier heading in the FIRST post specifically — later posts
 * (discussion, old snapshots quoted by other users) are not the source of
 * truth. Handles both the dex-linked entries (most tiers carry a sample-set
 * link) and entries that are plain text only (observed for the entire D
 * tier, plus a few stragglers elsewhere) — both collapse to the same plain
 * text once tags are stripped, so no special-casing is needed for either
 * shape. Returns null if the expected structure isn't found at all (thread
 * layout changed completely) rather than guessing.
 */
export function parseVrThreadFirstPost(html: string): RawVrEntry[] | null {
  const bodyStart = html.indexOf('class="message-body');
  if (bodyStart === -1) return null;
  // The inner "message-body" wrapper can itself contain nested
  // "message-body"-tagged embeds (quotes, attachments) — the real post
  // boundary is the NEXT full post wrapper, not just any further tag.
  const nextPostStart = html.indexOf('<article class="message message--post', bodyStart + 1);
  const chunk = nextPostStart === -1 ? html.slice(bodyStart) : html.slice(bodyStart, nextPostStart);

  // The post usually restates each rank's meaning in prose near the top
  // (mentioning tier names in sentences) before the real list — anchor on
  // the list's own header line to skip past that.
  const listStart = chunk.search(/Ranking Tier List/i);
  const listChunk = listStart === -1 ? chunk : chunk.slice(listStart);

  const text = decodeEntities(
    listChunk
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  );
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  const entries: RawVrEntry[] = [];
  let currentTier: VrTier | null = null;
  for (const line of lines) {
    if (line === 'Rules') break; // end of the tier list section
    if ((TIER_LABELS as readonly string[]).includes(line)) {
      currentTier = line as VrTier;
      continue;
    }
    if (/^D Rank$/.test(line)) {
      currentTier = 'D'; // D has no separate short label of its own — "D Rank" IS the label
      continue;
    }
    if (/^[SABC] Rank\b/.test(line)) continue; // group divider (e.g. "A Rank"), not a tier change
    if (!currentTier) continue;
    if (/^Reminder:/i.test(line)) continue; // D tier's own description line

    entries.push({ tier: currentTier, displayName: line });
  }
  return entries.length ? entries : null;
}

/** Resolve one VR thread display name to the real, canonical @pkmn/dex
 *  species name it refers to — direct lookup first, the thread's own
 *  abbreviation table second. Returns the resolved species' OWN canonical
 *  name, not necessarily `displayName` itself: a dex lookup can succeed on
 *  a name that isn't canonical (e.g. "Primal Groudon" resolves but the real
 *  name is "Groudon-Primal"), so this always reads speciesMeta's own `name`
 *  field back rather than assuming the input was already correct. Returns
 *  undefined (and never throws) for a name that resolves to neither, so one
 *  unrecognized entry can't take down the whole fetch. */
export function resolveVrDisplayName(gen: Generation, displayName: string): string | undefined {
  const direct = speciesMeta(gen, displayName);
  if (direct) return direct.name;
  const aliased = NAME_ALIASES[displayName];
  const viaAlias = aliased ? speciesMeta(gen, aliased) : undefined;
  return viaAlias?.name;
}

// A real VR list post always has well over 100 ranked mons. If a fetch or
// parse yields far fewer than that, something about the thread's structure
// changed under us — treat it as a failure rather than silently handing
// back a truncated, wrong candidate pool.
const MIN_PLAUSIBLE_ENTRIES = 40;

/**
 * Fetch and parse a VR thread's current first post into a
 * species -> tier map, re-derived fresh on every call (no caching, and
 * nothing persisted to disk) so it always reflects whatever the council
 * currently has posted — a tier list this consequential (it gates which
 * Pokemon a counter-team build is even allowed to consider) shouldn't ever
 * be working off a stale snapshot. Returns null on any failure (network,
 * unexpected page structure, or a suspiciously small parse) so the caller
 * can degrade gracefully instead of building a team off a broken/partial
 * list.
 */
// A candidate pool this consequential shouldn't collapse to "basically just
// the mandatory pick" over one transient blip (a dropped connection, a
// momentary 5xx/rate-limit from Smogon) — retry a couple of times with a
// short backoff before actually giving up.
const FETCH_RETRIES = 2;
const RETRY_DELAY_MS = 600;

async function fetchWithRetry(url: string, fetchImpl: typeof fetch): Promise<string | null> {
  for (let attempt = 0; attempt <= FETCH_RETRIES; attempt++) {
    try {
      const res = await fetchImpl(url);
      if (res.ok) return await res.text();
    } catch {
      /* network error — fall through to retry/give up below */
    }
    if (attempt < FETCH_RETRIES) await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * (attempt + 1)));
  }
  return null;
}

export async function fetchLiveVrMap(
  gen: Generation,
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Record<string, VrTier> | null> {
  const html = await fetchWithRetry(url, fetchImpl);
  if (!html) return null;

  const raw = parseVrThreadFirstPost(html);
  if (!raw || raw.length < MIN_PLAUSIBLE_ENTRIES) return null;

  const map: Record<string, VrTier> = {};
  for (const { tier, displayName } of raw) {
    const resolved = resolveVrDisplayName(gen, displayName);
    if (!resolved) continue; // unrecognized abbreviation — skip rather than guess
    // A species should only appear once; if a parsing hiccup ever produces
    // it under two tiers, keep the higher (more viable) rank.
    const existing = map[resolved];
    if (!existing || VR_TIER_SCORE[tier] > VR_TIER_SCORE[existing]) map[resolved] = tier;
  }
  return Object.keys(map).length >= MIN_PLAUSIBLE_ENTRIES ? map : null;
}
