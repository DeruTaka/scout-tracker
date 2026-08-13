// Write the three tabs to a Google Sheet. Supports four auth methods so it
// works whether or not your org allows service-account keys, locally or hosted:
//   1. OAuth refresh token via env  (best for hosted servers)
//   2. OAuth token file             (from `scout auth google`, best locally)
//   3. Service-account key file     (GOOGLE_APPLICATION_CREDENTIALS)
//   4. Application Default Creds     (gcloud auth application-default login)
// The datastore is the source of truth, so each run rebuilds the tabs.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { google } from 'googleapis';
import { authenticate } from '@google-cloud/local-auth';
import type { Datastore } from '../store/datastore.js';
import { buildSheets } from './rows.js';

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];

export interface GoogleConfig {
  sheetId: string;
}

export function googleConfigFromEnv(): GoogleConfig | null {
  const sheetId = process.env.SHEET_ID;
  return sheetId ? { sheetId } : null;
}

function tokenPath(): string {
  return process.env.GOOGLE_TOKEN_PATH || './data/google-token.json';
}

/** Sync check that SOME Google auth is configured (used for UI status). */
export function googleAuthConfigured(): boolean {
  if (process.env.GOOGLE_OAUTH_REFRESH_TOKEN && process.env.GOOGLE_OAUTH_CLIENT_ID) return true;
  if (existsSync(tokenPath())) return true;
  const sa = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  return !!(sa && existsSync(sa));
}

async function resolveAuth(): Promise<any | null> {
  // 1. Refresh token from env (hosted deployments — no files on disk).
  const rt = process.env.GOOGLE_OAUTH_REFRESH_TOKEN;
  const cid = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const cs = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (rt && cid && cs) {
    const o = new google.auth.OAuth2(cid, cs);
    o.setCredentials({ refresh_token: rt });
    return o;
  }
  // 2. Saved OAuth token file (from `scout auth google`).
  const tp = tokenPath();
  if (existsSync(tp)) {
    return google.auth.fromJSON(JSON.parse(readFileSync(tp, 'utf8'))) as any;
  }
  // 3. Service-account key.
  const sa = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (sa && existsSync(sa)) {
    return new google.auth.GoogleAuth({ keyFile: sa, scopes: SCOPES });
  }
  // 4. Application Default Credentials (gcloud auth application-default login).
  try {
    const adc = new google.auth.GoogleAuth({ scopes: SCOPES });
    await adc.getClient();
    return adc;
  } catch {
    return null;
  }
}

/**
 * Run the interactive OAuth consent (opens a browser, loopback redirect) and
 * cache the resulting refresh token to the token file. Returns the refresh
 * token so it can also be set as an env var for a hosted deployment.
 */
export async function authorizeGoogleOAuth(): Promise<string> {
  const clientPath = process.env.GOOGLE_OAUTH_CLIENT;
  if (!clientPath || !existsSync(clientPath)) {
    throw new Error('Set GOOGLE_OAUTH_CLIENT in .env to your downloaded OAuth client JSON (type: Desktop app).');
  }
  const client = await authenticate({ scopes: SCOPES, keyfilePath: clientPath });
  const refresh = client.credentials?.refresh_token;
  if (!refresh) {
    throw new Error('No refresh token returned — revoke the app under your Google account and retry.');
  }
  const keys = JSON.parse(readFileSync(clientPath, 'utf8'));
  const key = keys.installed || keys.web;
  const tp = tokenPath();
  if (!existsSync(dirname(tp))) mkdirSync(dirname(tp), { recursive: true });
  writeFileSync(
    tp,
    JSON.stringify(
      { type: 'authorized_user', client_id: key.client_id, client_secret: key.client_secret, refresh_token: refresh },
      null,
      2,
    ),
  );
  return refresh;
}

export async function writeGoogleSheet(store: Datastore, cfg: GoogleConfig): Promise<string> {
  const auth = await resolveAuth();
  if (!auth) {
    throw new Error(
      'no Google auth available — run `npm run scout -- auth google`, or set GOOGLE_OAUTH_REFRESH_TOKEN / a service account / ADC',
    );
  }
  const sheets = google.sheets({ version: 'v4', auth });
  const data = buildSheets(store);

  // Ensure each tab exists.
  const meta = await sheets.spreadsheets.get({ spreadsheetId: cfg.sheetId });
  const existing = new Set((meta.data.sheets ?? []).map((s) => s.properties?.title));
  const toAdd = data.filter((d) => !existing.has(d.name));
  if (toAdd.length) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: cfg.sheetId,
      requestBody: { requests: toAdd.map((d) => ({ addSheet: { properties: { title: d.name } } })) },
    });
  }

  // Clear + rewrite each tab.
  for (const sheet of data) {
    await sheets.spreadsheets.values.clear({ spreadsheetId: cfg.sheetId, range: `${sheet.name}` });
    await sheets.spreadsheets.values.update({
      spreadsheetId: cfg.sheetId,
      range: `${sheet.name}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [sheet.header, ...sheet.rows] },
    });
  }

  return `https://docs.google.com/spreadsheets/d/${cfg.sheetId}/edit`;
}
