// Fetch a PokePaste's raw text by URL or bare id. Mirrors replay/fetch.ts's
// retry/HTML-detection conventions, but pokepast.es's raw endpoint returns
// plain text (not JSON).
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Extract a paste id from a pokepast.es URL, or return the input if it's
 *  already a bare id. */
export function normalizePasteId(input: string): string {
  const trimmed = input.trim();
  const m = /pokepast\.es\/([A-Za-z0-9]+)/.exec(trimmed);
  return m ? m[1]! : trimmed;
}

/** True if `input` contains a pokepast.es URL anywhere in it. */
export function findPasteUrl(input: string): string | null {
  const m = /https?:\/\/pokepast\.es\/[A-Za-z0-9]+/.exec(input);
  return m ? m[0] : null;
}

async function fetchText(url: string, retries = 2): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url);
    if (res.status === 429 || res.status >= 500) {
      if (attempt < retries) {
        await sleep(600 * (attempt + 1));
        continue;
      }
      throw new Error(`HTTP ${res.status} (rate-limited or server error after ${retries + 1} tries)`);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (text.trimStart().startsWith('<')) {
      if (attempt < retries) {
        await sleep(600 * (attempt + 1));
        continue;
      }
      throw new Error('server returned HTML, not plain text (likely rate-limited or the paste is missing)');
    }
    return text;
  }
}

/** Fetch a PokePaste's raw text by URL or bare id. */
export async function fetchPaste(input: string): Promise<string> {
  const id = normalizePasteId(input);
  try {
    return await fetchText(`https://pokepast.es/${id}/raw`);
  } catch (e) {
    throw new Error(`Failed to fetch PokePaste ${id}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
