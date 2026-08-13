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
}

export function getConfig(): Config {
  loadEnv();
  return {
    storePath: process.env.STORE_PATH || root('data/store.json'),
    xlsxPath: process.env.XLSX_PATH || root('data/scouter.xlsx'),
    port: Number(process.env.PORT) || 5178,
  };
}
