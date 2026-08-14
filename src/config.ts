// Runtime configuration from environment (.env is loaded if present).
import { fileURLToPath } from 'node:url';

export function loadEnv(): void {
  try {
    // Node >= 20.12 built-in; no dotenv dependency needed.
    (process as any).loadEnvFile?.('.env');
  } catch {
    /* no .env file — fine */
  }
}

function root(rel: string): string {
  return fileURLToPath(new URL(`../${rel}`, import.meta.url));
}

export interface Config {
  storePath: string;
  xlsxPath: string;
  port: number;
  /** URL to embed the live sheet in an <iframe> on the /sheet page, if any. */
  sheetEmbedUrl?: string;
}

/**
 * Resolve the sheet-embed URL. Prefer an explicit SHEET_EMBED_URL (paste the
 * src from Google Sheets' "Publish to web → Embed"). Otherwise best-effort
 * derive one from SHEET_ID via the htmlembed view, which renders for a sheet
 * shared "anyone with the link".
 */
function resolveSheetEmbedUrl(): string | undefined {
  const explicit = process.env.SHEET_EMBED_URL?.trim();
  if (explicit) return explicit;
  const id = process.env.SHEET_ID?.trim();
  if (id) return `https://docs.google.com/spreadsheets/d/${id}/htmlembed?widget=true&headers=false`;
  return undefined;
}

export function getConfig(): Config {
  loadEnv();
  return {
    storePath: process.env.STORE_PATH || root('data/store.json'),
    xlsxPath: process.env.XLSX_PATH || root('data/scouter.xlsx'),
    port: Number(process.env.PORT) || 5178,
    sheetEmbedUrl: resolveSheetEmbedUrl(),
  };
}
