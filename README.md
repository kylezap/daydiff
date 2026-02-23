# DayDiff

Daily data diff reporter. Fetches datasets from a REST API, stores daily snapshots in SQLite, computes row-level and aggregate diffs, and serves an on-demand browser dashboard.

## Quick Start

```bash
# Install dependencies
npm install
cd dashboard && npm install && npm run build && cd ..

# Configure
cp .env.example .env
# Edit .env with your API credentials, proxy, and SSL settings
# Edit config/datasets.mjs to define your datasets

# Fetch today's data and compute diff
npm start

# View the dashboard
npm run dashboard
```

## Dashboard Development

For local development with hot reload (Vite on port 5173, API proxied from port 3000):

```bash
# From project root — runs backend + Vite dev server together
npm run dev
```

Then open http://localhost:5173. The frontend proxies `/api` to the backend on port 3000.

## CLI Commands

```bash
node src/cli.mjs fetch            # Fetch today's datasets
node src/cli.mjs diff             # Compute diff vs previous day
node src/cli.mjs run              # Fetch + diff in one step
node src/cli.mjs dashboard        # Start dashboard on localhost:3000
node src/cli.mjs status           # Show latest fetch/diff summary
node src/cli.mjs install-schedule # Install macOS launchd daily job. To unload: launchctl unload "~/Library/LaunchAgents/com.daydiff.daily.plist"
```

## Configuration

- **`.env`** — API credentials, proxy settings, SSL config, dashboard port
- **`config/datasets.mjs`** — Define which API endpoints to fetch, row keys, and field mappings

## Known Issues / TODO

_(None at this time. Pagination uses single-pass sequential offset; see `docs/devgrid-pagination-issue.md` for historical context.)_

## Security Notes

- Dashboard binds only to `127.0.0.1` (localhost)
- API keys and proxy credentials stay in `.env` (gitignored)
- Supports custom CA certificates for corporate proxy environments
- Supports explicit proxy configuration via `HTTPS_PROXY`
