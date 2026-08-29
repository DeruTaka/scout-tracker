// Live fetch + parse of a Smogon Viability Rankings thread's first post —
// used instead of a hand-maintained static list so a tier's usable-Pokemon
// set always reflects whatever the council currently has posted, not a
// snapshot that silently drifts out of date. Re-fetched on every
// buildCounterTeam call for a VR-driven tier (see team-builder.ts) — one
// HTTP GET + string parsing per call, not per-candidate, so the cost is
// negligible next to everything else a counter-team build already does.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Generation } from '@pkmn/data';
import { speciesMeta } from '../data/dex.js';

const CACHE_DIR = fileURLToPath(new URL('../../data/cache/', import.meta.url));

export type VrTier = 'S+' | 'S' | 'S-' | 'A+' | 'A' | 'A-' | 'B+' | 'B' | 'B-' | 'C+' | 'C' | 'C-' | 'D';
const TIER_LABELS: readonly VrTier[] = ['S+', 'S', 'S-', 'A+', 'A', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'C-', 'D'];

// Steep, not linear: S+ through A- need to dominate a candidate's overall
// score decisively over B/C-tier, even against a meaningfully better
// matchup or history bonus elsewhere — a real request after the search
// kept reaching for low-tier mons just because they had the right type or
// a marginally better matchup than a real top-tier answer. The old linear
// 13..2 scale left barely any gap between neighboring tiers relative to
// how much a strong matchup could swing a candidate's score, so a C-tier
// mon with a great matchup could out-score an A-tier mon with a merely
// good one. This scale (combined with vrListViability's own weight
// multiplier below) keeps that from happening except in genuinely extreme
// matchup mismatches.
export const VR_TIER_SCORE: Record<VrTier, number> = {
  'S+': 120, S: 108, 'S-': 96,
  'A+': 70, A: 60, 'A-': 50,
  'B+': 30, B: 22, 'B-': 15,
  'C+': 8, C: 5, 'C-': 2,
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

// A candidate pool this consequential shouldn't collapse to "basically just
// the mandatory pick" over one transient blip (a dropped connection, a
// momentary 5xx/rate-limit from Smogon) — retry a couple of times with a
// short backoff before actually giving up.
const FETCH_RETRIES = 2;
const RETRY_DELAY_MS = 600;

async function fetchWithRetry(url: string, fetchImpl: typeof fetch): Promise<{ html: string | null; reason: string | null }> {
  let reason: string | null = null;
  for (let attempt = 0; attempt <= FETCH_RETRIES; attempt++) {
    try {
      // Smogon's forums (unlike its static stats/dex JSON mirrors) sit
      // behind bot-protection that reacts to Node's bare fetch() — no
      // User-Agent, no Accept header, nothing an ordinary browser request
      // wouldn't have — with a flat 403, not a rate-limit response. A
      // realistic browser-shaped request header set is what actually gets
      // through; a server/datacenter egress IP hits this far more reliably
      // than a home connection would.
      const res = await fetchImpl(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });
      if (res.ok) return { html: await res.text(), reason: null };
      reason = `HTTP ${res.status}${res.status === 429 ? ' (rate-limited)' : res.status === 403 ? ' (blocked)' : ''}`;
    } catch (e) {
      reason = e instanceof Error ? e.message : String(e);
    }
    if (attempt < FETCH_RETRIES) await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * (attempt + 1)));
  }
  return { html: null, reason };
}

// Re-fetching on literally every call means every rapid-fire retry (a user
// hitting "try again" a few times after a failure, or building several
// counter-teams back to back) sends a fresh request to Smogon's forums —
// exactly the kind of pattern that trips rate-limiting in the first place.
// A short in-memory cache breaks that loop while staying, in any practical
// sense, "live": the council doesn't revise a VR list minute to minute, so
// nothing meaningful goes stale in this window — it just stops hammering
// the same page over and over for calls seconds apart. Not persisted to
// disk, and gone the moment the process restarts.
const CACHE_TTL_MS = 5 * 60 * 1000;
let cache: { url: string; map: Record<string, VrTier>; fetchedAt: number } | null = null;

/** Test-only: clear the in-memory cache so tests using different fetchImpl
 *  stubs against the same URL don't see a previous test's cached result. */
export function _clearVrCacheForTests(): void {
  cache = null;
}

/** Test-only: delete the on-disk last-known-good fallback for `formatid`,
 *  so a test exercising "no live fetch AND no saved copy" doesn't
 *  accidentally succeed off a file a previous real run (or test) left
 *  behind. Best-effort — a missing file is not an error. */
export function _clearSavedVrMapForTests(formatid: string): void {
  try {
    if (existsSync(savedMapPath(formatid))) writeFileSync(savedMapPath(formatid), '');
  } catch {
    /* ignore */
  }
}

// A hosted deployment's egress IP (Render, Railway, Fly, ...) is shared
// across many unrelated services and gets bot-protection-blocked by
// Cloudflare far more readily than a home connection — realistic headers
// (above) fix most of that, but not all of it, and it can recur. When even
// a fresh, retried fetch is rejected, falling back to the last SUCCESSFUL
// fetch (persisted to disk, arbitrarily old) keeps the feature usable
// instead of hard-failing every build until Smogon's forums happen to let
// this IP back in. This is a fallback of last resort, not the normal path —
// the live fetch above is always tried first, on every call.
function savedMapPath(formatid: string): string {
  return join(CACHE_DIR, `vr-${formatid}.json`);
}

function loadSavedVrMap(formatid: string): { map: Record<string, VrTier>; savedAt: number } | null {
  try {
    const parsed = JSON.parse(readFileSync(savedMapPath(formatid), 'utf8'));
    if (parsed && typeof parsed === 'object' && parsed.map && typeof parsed.savedAt === 'number') return parsed;
    return null;
  } catch {
    return null;
  }
}

function saveVrMap(formatid: string, map: Record<string, VrTier>): void {
  try {
    if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(savedMapPath(formatid), JSON.stringify({ map, savedAt: Date.now() }));
  } catch {
    /* best-effort — a write failure here shouldn't break the live result */
  }
}

export interface VrFetchResult {
  map: Record<string, VrTier> | null;
  /** Set whenever the LIVE fetch itself failed, even if `map` ended up
   *  populated from the saved fallback — a caller can use this to warn
   *  "using a cached list" without treating it as a hard error. */
  reason: string | null;
  /** True if `map` came from the on-disk last-known-good fallback, not a
   *  fresh fetch. */
  stale: boolean;
  /** When the stale fallback was originally fetched (only set if `stale`). */
  savedAt?: number;
}

/**
 * Fetch and parse a VR thread's current first post into a
 * species -> tier map (cached briefly in memory — see CACHE_TTL_MS above —
 * so this always reflects whatever the council currently has posted,
 * without re-fetching on every single call). `formatid` keys the on-disk
 * last-known-good fallback used if the live fetch fails outright. Returns
 * `{ map: null, reason, stale: false }` only when there's neither a fresh
 * fetch NOR any previously-saved copy to fall back to.
 */
export async function fetchLiveVrMap(
  gen: Generation,
  url: string,
  formatid: string,
  fetchImpl: typeof fetch = fetch,
): Promise<VrFetchResult> {
  if (cache && cache.url === url && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return { map: cache.map, reason: null, stale: false };
  }

  const fail = (reason: string): VrFetchResult => {
    const saved = loadSavedVrMap(formatid);
    return saved ? { map: saved.map, reason, stale: true, savedAt: saved.savedAt } : { map: null, reason, stale: false };
  };

  const { html, reason: fetchReason } = await fetchWithRetry(url, fetchImpl);
  if (!html) return fail(fetchReason ?? 'fetch failed');

  const raw = parseVrThreadFirstPost(html);
  if (!raw) return fail("couldn't find the tier list in the page (its layout may have changed)");
  if (raw.length < MIN_PLAUSIBLE_ENTRIES) {
    return fail(`only parsed ${raw.length} entries, expected 100+ (the page's layout may have changed)`);
  }

  const map: Record<string, VrTier> = {};
  for (const { tier, displayName } of raw) {
    const resolved = resolveVrDisplayName(gen, displayName);
    if (!resolved) continue; // unrecognized abbreviation — skip rather than guess
    // A species should only appear once; if a parsing hiccup ever produces
    // it under two tiers, keep the higher (more viable) rank.
    const existing = map[resolved];
    if (!existing || VR_TIER_SCORE[tier] > VR_TIER_SCORE[existing]) map[resolved] = tier;
  }
  if (Object.keys(map).length < MIN_PLAUSIBLE_ENTRIES) {
    return fail(`only resolved ${Object.keys(map).length} real species names out of ${raw.length} parsed entries`);
  }
  cache = { url, map, fetchedAt: Date.now() };
  saveVrMap(formatid, map);
  return { map, reason: null, stale: false };
}
