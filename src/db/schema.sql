-- DayDiff SQLite Schema

-- Metadata about each configured dataset
CREATE TABLE IF NOT EXISTS datasets (
  id INTEGER PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  endpoint TEXT NOT NULL,
  row_key TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'platform',
  created_at TEXT DEFAULT (datetime('now'))
);

-- Daily snapshots
CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY,
  dataset_id INTEGER NOT NULL REFERENCES datasets(id),
  fetched_date TEXT NOT NULL,
  row_count INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(dataset_id, fetched_date)
);

-- Individual rows within a snapshot
CREATE TABLE IF NOT EXISTS snapshot_rows (
  id INTEGER PRIMARY KEY,
  snapshot_id INTEGER NOT NULL REFERENCES snapshots(id),
  row_key TEXT NOT NULL,
  row_data TEXT NOT NULL,
  UNIQUE(snapshot_id, row_key)
);

-- Diff reports between two consecutive snapshots
CREATE TABLE IF NOT EXISTS diffs (
  id INTEGER PRIMARY KEY,
  dataset_id INTEGER NOT NULL REFERENCES datasets(id),
  from_date TEXT NOT NULL,
  to_date TEXT NOT NULL,
  added_count INTEGER NOT NULL DEFAULT 0,
  removed_count INTEGER NOT NULL DEFAULT 0,
  modified_count INTEGER NOT NULL DEFAULT 0,
  unchanged_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(dataset_id, from_date, to_date)
);

-- Individual row-level changes (slim storage format)
--   row_data:       the current (or last-known) full row as JSON
--                   For added/modified: the new row.  For removed: the old row.
--   field_changes:  for modified rows only — { field: { old, new } } for changed fields
--   changed_fields: JSON array of field names that changed (for modified rows)
CREATE TABLE IF NOT EXISTS diff_items (
  id INTEGER PRIMARY KEY,
  diff_id INTEGER NOT NULL REFERENCES diffs(id),
  row_key TEXT NOT NULL,
  change_type TEXT NOT NULL CHECK(change_type IN ('added','removed','modified')),
  row_data TEXT,
  field_changes TEXT,
  changed_fields TEXT,
  UNIQUE(diff_id, row_key)
);

CREATE INDEX IF NOT EXISTS idx_diffs_dates ON diffs(to_date, dataset_id);
CREATE INDEX IF NOT EXISTS idx_diff_items_type ON diff_items(diff_id, change_type);
CREATE INDEX IF NOT EXISTS idx_snapshot_rows_key ON snapshot_rows(snapshot_id, row_key);
