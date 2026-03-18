# DayDiff

DayDiff tracks daily API data changes: it fetches datasets, stores snapshots in SQLite, computes row-level diffs, and serves a local dashboard for analysis and data quality checks.

## DevGrid Customer Success Use Case

DayDiff is designed for Customer Success teams who manage multiple DevGrid clients and need a reliable daily signal of what changed, where risk increased, and what to communicate.

Use DayDiff to:

- Track client-specific dataset movement day over day (added, removed, modified records).
- Spot data quality issues early (population drops, instability, referential integrity failures).
- Investigate vulnerability posture changes by client and prioritize follow-up.
- Export filtered change sets to share concrete evidence in internal reviews or client updates.
- Build a consistent daily operating rhythm: fetch, diff, review quality, escalate anomalies, and report outcomes.

## Quick Start

```bash
npm install
npm install --prefix dashboard
npm run build:dashboard

cp .env.example .env
# edit .env
# edit config/datasets.mjs

npm start
npm run dashboard
```

## Daily Workflow

```bash
# fetch + diff + quality checks (+ report if OPENAI_API_KEY is set)
npm start

# inspect status
npm run status
```

## Notebooks

Use notebooks for deeper vulnerability analysis and client-specific trend exploration.

```bash
# ensure data exists first
npm start

# python notebook environment
python3 -m venv .venv
source .venv/bin/activate
pip install -r notebooks/requirements.txt

# launch
jupyter lab
```

Primary notebook: `notebooks/vulnerability_eda.ipynb`  
Detailed notebook guidance: `notebooks/README.md`

## Development

```bash
# backend + Vite together
npm run dev
```

Open `http://localhost:5173`. Vite proxies `/api` to the backend (`http://127.0.0.1:3000` by default).  
If backend port is changed (for example `DASHBOARD_PORT=3001`), run dev with `VITE_API_PROXY=http://127.0.0.1:3001`.

## CLI Commands

```bash
node src/cli.mjs fetch --datasets Portfolios,Applications
node src/cli.mjs diff
node src/cli.mjs run
node src/cli.mjs status
node src/cli.mjs dashboard --port 3000
node src/cli.mjs prune --days 30
node src/cli.mjs backfill-vuln-distribution --days 30
node src/cli.mjs install-schedule
```

## Configuration

- `.env`: API auth, proxy, SSL, dashboard port, schedule, feature flags, report settings.
- `config/datasets.mjs`: dataset endpoints, row keys, category mapping.
- `config/default.mjs`: runtime defaults and environment mapping.

### Enable/Disable Datasets

Use these controls depending on whether the change is permanent or one-off:

1. One-off run (no config change): fetch only specific datasets.

```bash
node src/cli.mjs fetch --datasets Portfolios,Applications
```

2. Persistent platform dataset changes: edit `config/datasets.mjs`.
   - Enable by adding an object in `platformDatasets`.
   - Disable by removing/commenting a dataset object.

3. Persistent vulnerability dataset changes: edit `config/assets.mjs`.
   - Each asset creates one dataset named `vulns-<asset-name>`.
   - Enable by adding an asset `{ name, vulnerableId }`.
   - Disable by removing/commenting that asset entry.

After changing dataset config, run:

```bash
npm start
```

### Executive Report (On/Off)

Executive report generation runs at the end of `node src/cli.mjs run` / `npm start`.

- Turn **on**: set `OPENAI_API_KEY` in `.env` (optional: set `REPORT_MODEL`).
- Turn **off**: leave `OPENAI_API_KEY` empty/unset.

### Schedule Daily Pulls (macOS launchd)

1. Set schedule time in `.env` (24-hour clock):

```bash
SCHEDULE_HOUR=6
SCHEDULE_MINUTE=0
```

2. Install the daily job:

```bash
node src/cli.mjs install-schedule
```

3. Verify it runs by checking current status:

```bash
node src/cli.mjs status
```

To remove the schedule later:

```bash
launchctl unload "$HOME/Library/LaunchAgents/com.daydiff.daily.plist"
```

## Data Model and Docs

- `docs/DATA_MODEL.md`: schema and entity relationships.
- `docs/RAG.md`: RAG-related notes.
- `docs/devgrid-pagination-issue.md`: historical pagination context.
- `notebooks/README.md`: notebook setup and usage guidance.

## Security

- Dashboard binds to `127.0.0.1` only.
- Secrets remain in `.env` (gitignored).
- Supports explicit proxy config and custom CA certificates.
