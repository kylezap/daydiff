"""
Data-loading utilities for the DayDiff Vulnerability EDA.

Each function opens a read-only connection to the SQLite database,
runs a query scoped to vulnerability datasets, and returns a clean
pandas DataFrame with JSON columns flattened where appropriate.
"""

import json
import sqlite3
from pathlib import Path

import pandas as pd

DEFAULT_DB_PATH = Path(__file__).resolve().parent.parent / "data" / "daydiff.db"

# ── Severity colour palette (reused across all notebooks) ────────

SEVERITY_ORDER = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"]
SEVERITY_COLORS = {
    "CRITICAL": "#d62728",
    "HIGH": "#ff7f0e",
    "MEDIUM": "#bcbd22",
    "LOW": "#1f77b4",
    "INFO": "#7f7f7f",
}

STATUS_ORDER = ["detected", "in_progress", "resolved", "false_positive"]
SCAN_TYPE_ORDER = ["sast", "sca", "dast", "kics"]


def _connect(db_path=None):
    path = str(db_path or DEFAULT_DB_PATH)
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def _flatten_row_data(df, col="row_data"):
    """Parse a JSON text column into individual DataFrame columns."""
    if col not in df.columns or df.empty:
        return df

    parsed = df[col].apply(json.loads)
    flat = pd.json_normalize(parsed)
    flat.index = df.index
    df = df.drop(columns=[col])
    return pd.concat([df, flat], axis=1)


# ── 1. Latest snapshot ───────────────────────────────────────────

def load_latest_snapshot(db_path=None):
    """Load the most-recent vulnerability snapshot rows, one row per vuln.

    Returns a DataFrame with all JSON fields flattened into columns,
    plus ``fetched_date`` and ``dataset_name`` metadata.
    """
    conn = _connect(db_path)
    df = pd.read_sql_query(
        """
        SELECT
            sr.row_key,
            sr.row_data,
            s.fetched_date,
            ds.name AS dataset_name
        FROM snapshot_rows sr
        JOIN snapshots s  ON s.id  = sr.snapshot_id
        JOIN datasets  ds ON ds.id = s.dataset_id
        WHERE ds.category = 'vulnerability'
          AND s.fetched_date = (
              SELECT MAX(s2.fetched_date)
              FROM snapshots s2
              JOIN datasets d2 ON d2.id = s2.dataset_id
              WHERE d2.category = 'vulnerability'
          )
        """,
        conn,
    )
    conn.close()
    return _flatten_row_data(df)


# ── 2. All snapshots (for temporal / per-date analysis) ──────────

def load_all_snapshots(db_path=None):
    """Load *every* vulnerability snapshot row across all dates.

    Useful for computing age distributions, cumulative open counts, etc.
    Can be large — caller should filter/aggregate as needed.
    """
    conn = _connect(db_path)
    df = pd.read_sql_query(
        """
        SELECT
            sr.row_key,
            sr.row_data,
            s.fetched_date,
            ds.name AS dataset_name
        FROM snapshot_rows sr
        JOIN snapshots s  ON s.id  = sr.snapshot_id
        JOIN datasets  ds ON ds.id = s.dataset_id
        WHERE ds.category = 'vulnerability'
        ORDER BY s.fetched_date, ds.name
        """,
        conn,
    )
    conn.close()
    return _flatten_row_data(df)


# ── 3. Diff summaries (one row per dataset per day-pair) ─────────

def load_diff_summaries(db_path=None):
    """Daily diff summary stats for trend / churn charts."""
    conn = _connect(db_path)
    df = pd.read_sql_query(
        """
        SELECT
            d.from_date,
            d.to_date,
            d.added_count,
            d.removed_count,
            d.modified_count,
            d.unchanged_count,
            ds.name AS dataset_name
        FROM diffs d
        JOIN datasets ds ON ds.id = d.dataset_id
        WHERE ds.category = 'vulnerability'
        ORDER BY d.to_date, ds.name
        """,
        conn,
    )
    conn.close()
    return df


# ── 4. Diff items (row-level changes) ────────────────────────────

def load_diff_items(db_path=None):
    """Row-level change records with parsed field_changes.

    Returns columns: row_key, change_type, row_data (flat), field_changes
    (dict), changed_fields (list), from_date, to_date, dataset_name.
    """
    conn = _connect(db_path)
    df = pd.read_sql_query(
        """
        SELECT
            di.row_key,
            di.change_type,
            di.row_data,
            di.field_changes,
            di.changed_fields,
            d.from_date,
            d.to_date,
            ds.name AS dataset_name
        FROM diff_items di
        JOIN diffs    d  ON d.id  = di.diff_id
        JOIN datasets ds ON ds.id = d.dataset_id
        WHERE ds.category = 'vulnerability'
        ORDER BY d.to_date, ds.name
        """,
        conn,
    )
    conn.close()

    if not df.empty:
        df["field_changes"] = df["field_changes"].apply(
            lambda x: json.loads(x) if pd.notna(x) else {}
        )
        df["changed_fields"] = df["changed_fields"].apply(
            lambda x: json.loads(x) if pd.notna(x) else []
        )

    return df


# ── 5. Population trend ──────────────────────────────────────────

def load_population_trend(db_path=None):
    """Row counts per dataset per date — lightweight trend data."""
    conn = _connect(db_path)
    df = pd.read_sql_query(
        """
        SELECT
            s.fetched_date,
            s.row_count,
            s.api_total,
            ds.name AS dataset_name
        FROM snapshots s
        JOIN datasets ds ON ds.id = s.dataset_id
        WHERE ds.category = 'vulnerability'
        ORDER BY s.fetched_date, ds.name
        """,
        conn,
    )
    conn.close()
    return df
