# PS Team Scouter

Reconstruct **both** teams from Pokémon Showdown replays — for **any format on the
site** — and turn them into importable team pastes, inferred sets, and calc-derived EV
spreads. Everything accumulates into a per-trainer library of **unique sets** and an
auto-updating **spreadsheet** (local `.xlsx` always; Google Sheets optionally).

Point it at a replay URL, a batch of them, or a whole user's replay page. Repeat opponents
get sharper over time because past sets and common usage feed back into the analysis.

---

## What it does

For each replay it:

1. **Fetches** the replay JSON and reads the format/gen from it (so it's format-agnostic).
2. **Parses the log** into each player's full 6-mon roster plus everything revealed in play:
   moves, items, abilities, formes, tera, gender, level. Cosmetic/battle formes and
   nicknames are resolved via `@pkmn/dex`.
3. **Matches sets** — scores the revealed info against the Smogon dex sets for that format
   (`pkmn.github.io/smogon/data/sets/{format}.json`) plus the trainer's historical sets and
   common usage, and merges the best fit with the revealed facts.
4. **Selects the set by damage** — when reveals don't disambiguate (e.g. only a shared move
   seen), the observed damage picks which candidate set actually fits. This is what tells a
   defensive Tapu Bulu from an offensive one.
5. **Derives EV spreads** — because both teams are known, it runs `@smogon/calc` on the real
   damage events (reconstructing weather/terrain/screens/boosts/status at each hit) and, when
   observed damage doesn't fit the dex spread, searches for the minimal-deviation legal spread
   that does. KO hits are treated as lower bounds; crits/rolls are ignored; when nothing fits
   cleanly it keeps the dex spread and says so.
6. **Validates + exports** — checks final moves against the gen's learnset and emits importable
   single-mon and full-team pastes.
7. **Stores** everything and dedupes **unique sets per trainer** (unique by
   format / moves / item / ability / nature / EVs / tera / level / forme).
8. **Writes the sheet** — three tabs: `Sets`, `Teams`, `UniqueSets`.

---

## Install

```bash
npm install
```

Requires Node ≥ 20.12 (developed on Node 24).

## Usage

```bash
# scout + store one or more replays, then rebuild the sheet
npm run scout -- add https://replay.pokemonshowdown.com/smogtours-gen8uu-963226
npm run scout -- add gen9ou-1234567 gen9vgc2024-2345678

# scout every public replay for a user
npm run scout -- user "Taka" --max 50

# just print both team pastes, without storing (manual mode)
npm run scout -- paste smogtours-gen8uu-963226

# rebuild xlsx / Google Sheet from the stored data
npm run scout -- sheet

# local web UI (paste URLs, see teams + pastes, browse unique sets)
npm run serve
# -> http://localhost:5178
```

Re-adding a stored replay is skipped (idempotent). Use the web UI's *re-scout* checkbox or
`add` after deleting it from the store to force a re-scout.

## Output

- **`data/scouter.xlsx`** — always written. Tabs:
  - **Sets**: one row per (replay, trainer, Pokémon) — revealed moves, matched set, final
    moves, ability/item/tera/nature, EVs, confidence, EV source, notes, importable text.
  - **Teams**: one row per (replay, trainer) — the full 6-mon paste.
  - **UniqueSets**: every distinct set per trainer, with times-seen and importable text.
- **`data/store.json`** — the canonical datastore (replays + unique sets). Inspectable.

## Google Sheets (optional)

The local `.xlsx` needs no setup. To also push to a live Google Sheet, pick **one** auth
method and set `SHEET_ID` (the id from the sheet URL) in `.env`.

### Method A — OAuth (recommended; works when service-account keys are blocked)

If your org enforces `iam.disableServiceAccountKeyCreation`, you can't download a key — use
OAuth as *yourself* instead:

1. GCP console → **APIs & Services → Credentials → Create OAuth client ID** →
   application type **Desktop app** → download the JSON to `./oauth_client.json`.
2. **Enable the Google Sheets API** for the project.
3. On the **OAuth consent screen**, add your Google account as a **Test user**.
4. In `.env`: `GOOGLE_OAUTH_CLIENT=./oauth_client.json` and `SHEET_ID=...`.
5. Authorize once (opens a browser):
   ```bash
   npm run scout -- auth google
   ```
   The token is cached to `data/google-token.json`. It also prints
   `GOOGLE_OAUTH_CLIENT_ID/SECRET/REFRESH_TOKEN` — save those for hosted deployments (below).

Share the Sheet with the Google account you authorized (it's your own, so usually already
owned by you).

### Method B — Service account (only if key creation is allowed)

Create a service account → JSON key → `credentials.json` here; **share the Sheet** with its
`client_email`; set `GOOGLE_APPLICATION_CREDENTIALS=./credentials.json`.

### Method C — Application Default Credentials

`gcloud auth application-default login --scopes=https://www.googleapis.com/auth/spreadsheets,https://www.googleapis.com/auth/cloud-platform`
— no env vars needed; used as a fallback.

Every `add` / `user` / `sheet` run rebuilds the three tabs from the datastore, so the sheet
"auto-updates" as you feed in more replays.

> No account setup at all? Just open `data/scouter.xlsx` in Google Sheets (Drive → New →
> upload, or File → Import) after each run.

## Hosting it publicly

The web UI (`scout serve`) is a normal Node HTTP server, so it runs on any container host.
Three things matter when it's not on your laptop:

1. **Lock it down.** The app writes to *your* Google Sheet and stores scouted data, so a public
   URL must not be open. Set `SCOUT_PASSWORD=...` — every request then needs HTTP Basic auth
   (any username, that password). (For real multi-user access, put it behind your own
   auth/proxy.)
2. **Persist `/app/data`.** The datastore, xlsx, and OAuth token live there. Most PaaS
   filesystems are ephemeral — attach a **persistent volume/disk** mounted at `/app/data`, or
   your history resets on every redeploy.
3. **Google auth without files.** On a server, set the three env vars printed by
   `scout auth google` (`GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`,
   `GOOGLE_OAUTH_REFRESH_TOKEN`) plus `SHEET_ID` — no token file needed.

A `Dockerfile` is included:

```bash
docker build -t team-scouter .
docker run -p 8080:8080 \
  -v scouter-data:/app/data \
  -e SHEET_ID=... \
  -e GOOGLE_OAUTH_CLIENT_ID=... -e GOOGLE_OAUTH_CLIENT_SECRET=... -e GOOGLE_OAUTH_REFRESH_TOKEN=... \
  -e SCOUT_PASSWORD=... \
  team-scouter
```

**Recommended platforms** (all support a container + a persistent disk + env secrets):
Render, Railway, or Fly.io for a managed deploy; or any small VPS with Docker. On Render/
Railway, point them at this repo, add a **disk** mounted at `/app/data`, and set the env vars
above; the platform injects `PORT` automatically (the app honors it).

Cost/abuse note: each scout fetches a replay and runs damage calcs, so keep it password-gated
and, if it'll be heavily used, front it with rate limiting at your proxy/platform.

## Configuration (`.env`)

| Var | Default | Purpose |
| --- | --- | --- |
| `STORE_PATH` | `./data/store.json` | JSON datastore |
| `XLSX_PATH` | `./data/scouter.xlsx` | local spreadsheet mirror |
| `PORT` | `5178` | web UI port |
| `GOOGLE_APPLICATION_CREDENTIALS` | — | service-account JSON (enables Sheets) |
| `SHEET_ID` | — | target spreadsheet id |

## How the EV engine works (and its limits)

The engine is a best-effort reconstruction, not a proof:

- HP is shown only in whole percents, so damage ranges are coarse (±1.5% tolerance).
- It starts from the matched dex spread and only moves EVs when the observed damage clearly
  justifies it, then by the smallest amount that fits (regularized, so it won't overfit
  rounding noise).
- KO hits only bound damage from below; crits, multi-hits, substitutes and fixed-damage moves
  (Seismic Toss, Foul Play, etc.) are dropped.
- If an item/ability wasn't revealed, the derived spread can compensate for a wrong assumption
  — the tool flags low confidence and, when nothing fits, keeps the dex spread with a note.

Confidence and provenance notes are attached to every set so you can see why it chose what it
did.

## Limitations

- Formats with no Smogon dex sets (many randoms / niche tiers) fall back to revealed moves +
  a generic spread (clearly marked low-confidence); damage evidence still refines them.
- Illusion (Zoroark) can misattribute reveals until the true mon is shown.
- Z-moves display as the Z-move name; the base move is usually revealed separately.

## Tests

```bash
npm test          # parser + EV engine, checked against a bundled replay fixture
npm run typecheck
```

## Project layout

```
src/
  replay/   fetch + log parser
  data/     dex helpers (species/legality) + Smogon sets provider
  match/    reveal-based set matching
  ev/       field reconstruction + @smogon/calc EV derivation + set selection
  build/    importable-set / team-paste export + legality
  store/    JSON datastore + unique-set dedupe + historical priors
  sheet/    row builders + xlsx + Google Sheets writers
  web/      express server + single-page UI
  scout.ts  end-to-end pipeline
  cli.ts    command-line entry
```
