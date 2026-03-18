# Notebooks

Analytical notebooks for ad-hoc exploration of DayDiff data, primarily for vulnerability trends and client-level risk analysis.

## Included

- `vulnerability_eda.ipynb`: end-to-end exploratory analysis across vulnerability datasets.
- `helpers.py`: shared SQLite loaders and transforms used by notebooks.
- `requirements.txt`: Python dependencies for notebook execution.

## Prerequisites

1. DayDiff data exists in `data/daydiff.db`.
2. Vulnerability datasets have been fetched/diffed at least once.

From project root:

```bash
npm start
```

## Setup

From project root:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r notebooks/requirements.txt
```

## Run

From project root:

```bash
jupyter lab
```

Open `notebooks/vulnerability_eda.ipynb`.

## Data Assumptions

- Notebook reads SQLite at `data/daydiff.db`.
- Queries are scoped to datasets where `category = 'vulnerability'`.
- If no vulnerability snapshots are present, charts and summaries will be empty.

## Troubleshooting

- `unable to open database file`: run DayDiff first (`npm start`) and confirm `data/daydiff.db` exists.
- Empty results: verify tracked assets in `config/assets.mjs`, then run `npm start` again.
- Missing Python packages: re-activate your virtual environment and reinstall `notebooks/requirements.txt`.

## Team Conventions

- Keep notebooks reproducible from a fresh environment.
- If notebook outputs become too large/noisy in diffs, clear outputs before committing.
