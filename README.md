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
node src/cli.mjs install-schedule # Install macOS launchd daily job
```

## Configuration

- **`.env`** — API credentials, proxy settings, SSL config, dashboard port
- **`config/datasets.mjs`** — Define which API endpoints to fetch, row keys, and field mappings

## Known Issues / TODO

### Pagination coverage gap (pending DevGrid fix)

The DevGrid API does not support server-side sorting on paginated endpoints. Without a stable sort order, offset-based pagination is unreliable — rows shift between pages across requests, causing some records to never appear regardless of how many passes are made. Testing shows ~80% coverage on `/repositories` (11,500 of 14,089) and similar gaps on `/applications`.

**Current mitigation:** Pages overlap by 10% to catch shifted rows; the `fetch-complete` assertion flags any gap between `row_count` and `api_total` on the dashboard.

**Fix:** A request has been filed with the DevGrid team to add a `sort` parameter. Once available:
1. Add the sort param (e.g., `sort=id`) to `fetchAllPages()` in `src/api/fetcher.mjs`
2. Verify 100% coverage on `/repositories` and `/applications`
3. Remove the overlap logic once stable pagination is confirmed

## Security Notes

- Dashboard binds only to `127.0.0.1` (localhost)
- API keys and proxy credentials stay in `.env` (gitignored)
- Supports custom CA certificates for corporate proxy environments
- Supports explicit proxy configuration via `HTTPS_PROXY`
