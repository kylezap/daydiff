import { createHash } from 'node:crypto';
import { getDb } from './index.mjs';

// ─── Helpers ─────────────────────────────────────────────────────

/**
 * Deterministic JSON serialization (sorted keys) for consistent hashing.
 */
function stableStringify(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(stableStringify).join(',') + ']';
  const keys = Object.keys(obj).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}

/**
 * Omit specified keys from an object (shallow). Returns a new object.
 */
function omitKeys(obj, keys) {
  if (!Array.isArray(keys) || keys.length === 0) return obj;
  const out = { ...obj };
  for (const k of keys) delete out[k];
  return out;
}

/**
 * Compute a SHA-256 hex hash of a row's data for change detection.
 * @param {object} data - Row data
 * @param {string[]} [excludeKeys=[]] - Top-level keys to omit from hash (e.g. identifiers, updatedAt)
 */
function hashRow(data, excludeKeys = []) {
  const hashable = omitKeys(data, excludeKeys);
  return createHash('sha256').update(stableStringify(hashable)).digest('hex');
}

// ─── Snapshot Queries ────────────────────────────────────────────

/**
 * Insert a snapshot and its rows inside a transaction.
 * @param {number} datasetId
 * @param {string} date - YYYY-MM-DD
 * @param {Array<{key: string, data: object}>} rows
 * @param {object} [meta] - Fetch metadata
 * @param {number} [meta.apiTotal] - Total count claimed by the API
 * @param {string} [meta.fetchWarnings] - Any warnings from the fetch
 * @param {string[]} [meta.diffIgnoreFields] - Keys to omit from hash (noise fields per dataset)
 * @returns {{snapshotId: number, rowCount: number}}
 */
export function insertSnapshot(datasetId, date, rows, meta = {}) {
  const db = getDb();
  const { apiTotal = null, fetchWarnings = null, diffIgnoreFields = [] } = meta;

  const insertSnap = db.prepare(`
    INSERT INTO snapshots (dataset_id, fetched_date, row_count, api_total, fetch_warnings)
    VALUES (?, ?, ?, ?, ?)
  `);

  const insertRow = db.prepare(`
    INSERT INTO snapshot_rows (snapshot_id, row_key, row_data, row_hash)
    VALUES (?, ?, ?, ?)
  `);

  const run = db.transaction(() => {
    // Delete existing snapshot for this dataset+date if re-running
    const existing = db.prepare(
      'SELECT id FROM snapshots WHERE dataset_id = ? AND fetched_date = ?'
    ).get(datasetId, date);

    if (existing) {
      db.prepare('DELETE FROM snapshot_rows WHERE snapshot_id = ?').run(existing.id);
      db.prepare('DELETE FROM snapshots WHERE id = ?').run(existing.id);
    }

    const result = insertSnap.run(datasetId, date, rows.length, apiTotal, fetchWarnings);
    const snapshotId = result.lastInsertRowid;

    for (const row of rows) {
      const json = JSON.stringify(row.data);
      const hash = hashRow(row.data, diffIgnoreFields);
      insertRow.run(snapshotId, String(row.key), json, hash);
    }

    return { snapshotId: Number(snapshotId), rowCount: rows.length };
  });

  return run();
}

/**
 * Create an empty snapshot for streaming inserts. Deletes existing snapshot for
 * dataset+date if present. Call insertSnapshotRowsBatch for each page, then
 * finalizeSnapshot when done.
 *
 * @param {number} datasetId
 * @param {string} date - YYYY-MM-DD
 * @returns {number} snapshotId
 */
export function createEmptySnapshot(datasetId, date) {
  const db = getDb();

  const run = db.transaction(() => {
    const existing = db.prepare(
      'SELECT id FROM snapshots WHERE dataset_id = ? AND fetched_date = ?'
    ).get(datasetId, date);

    if (existing) {
      db.prepare('DELETE FROM snapshot_rows WHERE snapshot_id = ?').run(existing.id);
      db.prepare('DELETE FROM snapshots WHERE id = ?').run(existing.id);
    }

    const result = db.prepare(`
      INSERT INTO snapshots (dataset_id, fetched_date, row_count, api_total, fetch_warnings)
      VALUES (?, ?, ?, ?, ?)
    `).run(datasetId, date, 0, null, null);

    return Number(result.lastInsertRowid);
  });

  return run();
}

/**
 * Insert a batch of rows into an existing snapshot (streaming mode).
 * Uses ON CONFLICT DO UPDATE so batches are idempotent; one transaction per batch.
 *
 * @param {number} snapshotId
 * @param {object[]} rows - Raw API rows (each must have rowKey field)
 * @param {string} rowKey - Field name for the row key (e.g. 'id')
 * @param {string[]} [diffIgnoreFields=[]] - Keys to omit from hash
 */
export function insertSnapshotRowsBatch(snapshotId, rows, rowKey, diffIgnoreFields = []) {
  if (rows.length === 0) return;

  const db = getDb();
  const insertRow = db.prepare(`
    INSERT INTO snapshot_rows (snapshot_id, row_key, row_data, row_hash)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(snapshot_id, row_key) DO UPDATE SET
      row_data = excluded.row_data,
      row_hash = excluded.row_hash
  `);

  const run = db.transaction(() => {
    for (const row of rows) {
      const key = row[rowKey];
      if (key === undefined || key === null) continue;
      const json = JSON.stringify(row);
      const hash = hashRow(row, diffIgnoreFields);
      insertRow.run(snapshotId, String(key), json, hash);
    }
  });

  run();
}

/**
 * Get the number of rows in a snapshot (for progress/convergence checks).
 * @param {number} snapshotId
 * @returns {number}
 */
export function getSnapshotRowCount(snapshotId) {
  const row = getDb().prepare(
    'SELECT COUNT(*) AS cnt FROM snapshot_rows WHERE snapshot_id = ?'
  ).get(snapshotId);
  return row.cnt;
}

/**
 * Finalize a snapshot after streaming inserts: set row_count, api_total, fetch_warnings.
 *
 * @param {number} snapshotId
 * @param {number|null} apiTotal
 * @param {string|null} fetchWarnings
 * @returns {{ rowCount: number }}
 */
export function finalizeSnapshot(snapshotId, apiTotal = null, fetchWarnings = null) {
  const db = getDb();

  const row = db.prepare(
    'SELECT COUNT(*) AS cnt FROM snapshot_rows WHERE snapshot_id = ?'
  ).get(snapshotId);
  const rowCount = row.cnt;

  db.prepare(`
    UPDATE snapshots
    SET row_count = ?, api_total = ?, fetch_warnings = ?
    WHERE id = ?
  `).run(rowCount, apiTotal, fetchWarnings, snapshotId);

  // Pre-compute vulnerability distribution for this snapshot so the dashboard can read instantly
  const meta = db.prepare(
    'SELECT s.dataset_id, s.fetched_date, ds.category FROM snapshots s JOIN datasets ds ON ds.id = s.dataset_id WHERE s.id = ?'
  ).get(snapshotId);
  if (meta && meta.category === 'vulnerability') {
    materializeVulnerabilityDistribution(snapshotId);
  }

  return { rowCount };
}

/**
 * Get the most recent snapshot for a dataset on or before a given date.
 */
export function getLatestSnapshot(datasetId, beforeDate) {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM snapshots
    WHERE dataset_id = ? AND fetched_date <= ?
    ORDER BY fetched_date DESC
    LIMIT 1
  `).get(datasetId, beforeDate);
}

/**
 * Get the snapshot immediately before a given date (for computing diffs).
 */
export function getPreviousSnapshot(datasetId, currentDate) {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM snapshots
    WHERE dataset_id = ? AND fetched_date < ?
    ORDER BY fetched_date DESC
    LIMIT 1
  `).get(datasetId, currentDate);
}

/**
 * Get all rows for a snapshot, keyed by row_key.
 * @returns {Map<string, object>}
 * @deprecated Use the SQL-based diff queries instead for large datasets.
 */
export function getSnapshotRows(snapshotId) {
  const db = getDb();
  const rows = db.prepare(
    'SELECT row_key, row_data FROM snapshot_rows WHERE snapshot_id = ?'
  ).all(snapshotId);

  const map = new Map();
  for (const r of rows) {
    map.set(r.row_key, JSON.parse(r.row_data));
  }
  return map;
}

// ─── SQL-Based Diff Queries (memory-efficient) ──────────────────

/**
 * Get rows that exist in newSnapId but not in oldSnapId (added rows).
 * Returns raw row_key and row_data (JSON string) to avoid parsing overhead.
 */
export function getAddedRows(newSnapId, oldSnapId) {
  const db = getDb();
  return db.prepare(`
    SELECT n.row_key, n.row_data
    FROM snapshot_rows n
    LEFT JOIN snapshot_rows o ON o.snapshot_id = ? AND o.row_key = n.row_key
    WHERE n.snapshot_id = ? AND o.id IS NULL
  `).all(oldSnapId, newSnapId);
}

/**
 * Get rows that exist in oldSnapId but not in newSnapId (removed rows).
 * Returns raw row_key and row_data (JSON string).
 */
export function getRemovedRows(oldSnapId, newSnapId) {
  const db = getDb();
  return db.prepare(`
    SELECT o.row_key, o.row_data
    FROM snapshot_rows o
    LEFT JOIN snapshot_rows n ON n.snapshot_id = ? AND n.row_key = o.row_key
    WHERE o.snapshot_id = ? AND n.id IS NULL
  `).all(newSnapId, oldSnapId);
}

/**
 * Get rows present in both snapshots whose hash differs (modified rows).
 * Returns row_key, old row_data, and new row_data as JSON strings.
 */
export function getModifiedRows(oldSnapId, newSnapId) {
  const db = getDb();
  return db.prepare(`
    SELECT o.row_key, o.row_data AS old_data, n.row_data AS new_data
    FROM snapshot_rows o
    JOIN snapshot_rows n ON n.snapshot_id = ? AND n.row_key = o.row_key
    WHERE o.snapshot_id = ? AND o.row_hash != n.row_hash
  `).all(newSnapId, oldSnapId);
}

/**
 * Count rows present in both snapshots with identical hashes (unchanged).
 * No row data is loaded — just returns the count.
 */
export function getUnchangedCount(oldSnapId, newSnapId) {
  const db = getDb();
  const row = db.prepare(`
    SELECT COUNT(*) AS cnt
    FROM snapshot_rows o
    JOIN snapshot_rows n ON n.snapshot_id = ? AND n.row_key = o.row_key
    WHERE o.snapshot_id = ? AND o.row_hash = n.row_hash
  `).get(newSnapId, oldSnapId);
  return row.cnt;
}

// ─── Diff Queries ────────────────────────────────────────────────

/**
 * Serialize a value to JSON string, passing through if already a string.
 */
function toJsonString(val) {
  if (val === null || val === undefined) return null;
  if (typeof val === 'string') return val;
  return JSON.stringify(val);
}

/**
 * Insert a diff report and its items.
 *
 * Item fields (rowData, fieldChanges, changedFields) can be either
 * objects (will be JSON-serialized) or pre-serialized JSON strings
 * (passed through as-is for performance with large datasets).
 */
export function insertDiff(datasetId, fromDate, toDate, summary, items) {
  const db = getDb();

  const run = db.transaction(() => {
    // Remove existing diff for this date pair if re-running
    const existing = db.prepare(
      'SELECT id FROM diffs WHERE dataset_id = ? AND from_date = ? AND to_date = ?'
    ).get(datasetId, fromDate, toDate);

    if (existing) {
      db.prepare('DELETE FROM diff_items WHERE diff_id = ?').run(existing.id);
      db.prepare('DELETE FROM diffs WHERE id = ?').run(existing.id);
    }

    const result = db.prepare(`
      INSERT INTO diffs (dataset_id, from_date, to_date, added_count, removed_count, modified_count, unchanged_count)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      datasetId, fromDate, toDate,
      summary.added, summary.removed, summary.modified, summary.unchanged
    );

    const diffId = Number(result.lastInsertRowid);

    const insertItem = db.prepare(`
      INSERT INTO diff_items (diff_id, row_key, change_type, row_data, field_changes, changed_fields)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    for (const item of items) {
      insertItem.run(
        diffId,
        item.rowKey,
        item.changeType,
        toJsonString(item.rowData),
        toJsonString(item.fieldChanges),
        toJsonString(item.changedFields),
      );
    }

    return diffId;
  });

  return run();
}

// ─── Dashboard API Queries ───────────────────────────────────────

/**
 * List all datasets, optionally filtered by category.
 */
export function listDatasets(category = null) {
  const db = getDb();
  if (category) {
    return db.prepare('SELECT * FROM datasets WHERE category = ? ORDER BY name').all(category);
  }
  return db.prepare('SELECT * FROM datasets ORDER BY name').all();
}

/**
 * List all diffs, optionally filtered by dataset and/or category.
 */
export function listDiffs(datasetId = null, limit = 90, category = null) {
  const db = getDb();
  const conditions = [];
  const params = [];

  if (datasetId) {
    conditions.push('d.dataset_id = ?');
    params.push(datasetId);
  }
  if (category) {
    conditions.push('ds.category = ?');
    params.push(category);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  return db.prepare(`
    SELECT d.*, ds.name as dataset_name
    FROM diffs d
    JOIN datasets ds ON ds.id = d.dataset_id
    ${where}
    ORDER BY d.to_date DESC
    LIMIT ?
  `).all(...params, limit);
}

/**
 * Get a single diff by ID.
 */
export function getDiff(diffId) {
  return getDb().prepare(`
    SELECT d.*, ds.name as dataset_name
    FROM diffs d
    JOIN datasets ds ON ds.id = d.dataset_id
    WHERE d.id = ?
  `).get(diffId);
}

/**
 * Get diff items for a diff, optionally filtered by change type.
 * Returns all items (use getDiffItemsPaginated for large datasets).
 */
export function getDiffItems(diffId, changeType = null) {
  const db = getDb();
  if (changeType) {
    return db.prepare(
      'SELECT * FROM diff_items WHERE diff_id = ? AND change_type = ? ORDER BY row_key'
    ).all(diffId, changeType);
  }
  return db.prepare(
    'SELECT * FROM diff_items WHERE diff_id = ? ORDER BY change_type, row_key'
  ).all(diffId);
}

/**
 * Get diff items with server-side pagination, filtering, and search.
 *
 * @param {number} diffId
 * @param {object} opts
 * @param {number} opts.offset - Starting row (default 0)
 * @param {number} opts.limit - Page size (default 100)
 * @param {string|null} opts.changeType - Filter by change type
 * @param {string|null} opts.search - Quick filter across row_key and data fields
 * @param {string} opts.sortField - Sort column (default 'change_type')
 * @param {string} opts.sortDir - 'ASC' or 'DESC' (default 'ASC')
 * @returns {{ rows: Array, total: number }}
 */
export function getDiffItemsPaginated(diffId, opts = {}) {
  const db = getDb();
  const {
    offset = 0,
    limit = 100,
    changeType = null,
    search = null,
    sortField = 'change_type',
    sortDir = 'ASC',
  } = opts;

  // Whitelist sort fields to prevent SQL injection
  const allowedSorts = ['change_type', 'row_key', 'id'];
  const safeSort = allowedSorts.includes(sortField) ? sortField : 'change_type';
  const safeDir = sortDir.toUpperCase() === 'DESC' ? 'DESC' : 'ASC';

  // Build WHERE clause
  const conditions = ['diff_id = ?'];
  const params = [diffId];

  if (changeType) {
    conditions.push('change_type = ?');
    params.push(changeType);
  }

  if (search) {
    // Search across row_key, row_data, field_changes, changed_fields
    conditions.push(
      '(row_key LIKE ? OR row_data LIKE ? OR field_changes LIKE ? OR changed_fields LIKE ?)'
    );
    const like = `%${search}%`;
    params.push(like, like, like, like);
  }

  const where = conditions.join(' AND ');

  // Count total matching rows
  const countRow = db.prepare(`SELECT COUNT(*) as cnt FROM diff_items WHERE ${where}`).get(...params);
  const total = countRow.cnt;

  // Fetch page
  const rows = db.prepare(
    `SELECT * FROM diff_items WHERE ${where} ORDER BY ${safeSort} ${safeDir}, row_key ASC LIMIT ? OFFSET ?`
  ).all(...params, limit, offset);

  return { rows, total };
}

/**
 * Get IDs of diff items matching filters (lightweight, for cross-page selection).
 *
 * @param {number} diffId
 * @param {object} opts
 * @param {string|null} opts.changeType - Filter by change type
 * @param {string|null} opts.search - Quick filter
 * @returns {{ ids: number[], total: number }}
 */
export function getDiffItemIds(diffId, opts = {}) {
  const db = getDb();
  const { changeType = null, search = null } = opts;

  const conditions = ['diff_id = ?'];
  const params = [diffId];

  if (changeType) {
    conditions.push('change_type = ?');
    params.push(changeType);
  }
  if (search) {
    conditions.push(
      '(row_key LIKE ? OR row_data LIKE ? OR field_changes LIKE ? OR changed_fields LIKE ?)'
    );
    const like = `%${search}%`;
    params.push(like, like, like, like);
  }

  const where = conditions.join(' AND ');
  const countRow = db.prepare(`SELECT COUNT(*) as cnt FROM diff_items WHERE ${where}`).get(...params);
  const total = countRow.cnt;
  const rows = db.prepare(
    `SELECT id FROM diff_items WHERE ${where} ORDER BY change_type ASC, row_key ASC LIMIT ?`
  ).all(...params, 1_000_000);
  const ids = rows.map((r) => r.id);
  return { ids, total };
}

/**
 * Get diff items by IDs (for export-selected flow).
 *
 * @param {number} diffId
 * @param {number[]} ids - Row IDs to fetch
 * @returns {Array}
 */
export function getDiffItemsByIds(diffId, ids) {
  if (!ids || ids.length === 0) return [];
  const db = getDb();
  const placeholders = ids.map(() => '?').join(',');
  return db.prepare(
    `SELECT * FROM diff_items WHERE diff_id = ? AND id IN (${placeholders}) ORDER BY change_type, row_key`
  ).all(diffId, ...ids);
}

/**
 * Get aggregate summary across datasets for a given date, optionally filtered by category.
 */
export function getSummaryForDate(date, category = null) {
  const db = getDb();
  if (category) {
    return db.prepare(`
      SELECT
        ds.name as dataset_name,
        d.added_count,
        d.removed_count,
        d.modified_count,
        d.unchanged_count,
        d.from_date,
        d.to_date,
        d.id as diff_id
      FROM diffs d
      JOIN datasets ds ON ds.id = d.dataset_id
      WHERE d.to_date = ? AND ds.category = ?
      ORDER BY ds.name
    `).all(date, category);
  }
  return db.prepare(`
    SELECT
      ds.name as dataset_name,
      d.added_count,
      d.removed_count,
      d.modified_count,
      d.unchanged_count,
      d.from_date,
      d.to_date,
      d.id as diff_id
    FROM diffs d
    JOIN datasets ds ON ds.id = d.dataset_id
    WHERE d.to_date = ?
    ORDER BY ds.name
  `).all(date);
}

/**
 * Get trend data: daily diff summaries for the last N days.
 * Optionally filtered by datasetId and/or category.
 */
export function getTrend(days = 30, datasetId = null, category = null) {
  const db = getDb();

  if (datasetId) {
    return db.prepare(`
      SELECT to_date, added_count, removed_count, modified_count, unchanged_count
      FROM diffs
      WHERE dataset_id = ?
      ORDER BY to_date DESC
      LIMIT ?
    `).all(datasetId, days);
  }

  if (category) {
    return db.prepare(`
      SELECT d.to_date,
        SUM(d.added_count) as added_count,
        SUM(d.removed_count) as removed_count,
        SUM(d.modified_count) as modified_count,
        SUM(d.unchanged_count) as unchanged_count
      FROM diffs d
      JOIN datasets ds ON ds.id = d.dataset_id
      WHERE ds.category = ?
      GROUP BY d.to_date
      ORDER BY d.to_date DESC
      LIMIT ?
    `).all(category, days);
  }

  return db.prepare(`
    SELECT to_date,
      SUM(added_count) as added_count,
      SUM(removed_count) as removed_count,
      SUM(modified_count) as modified_count,
      SUM(unchanged_count) as unchanged_count
    FROM diffs
    GROUP BY to_date
    ORDER BY to_date DESC
    LIMIT ?
  `).all(days);
}

/**
 * Get all available diff dates, optionally filtered by category.
 */
export function getAvailableDates(category = null) {
  const db = getDb();
  if (category) {
    return db.prepare(`
      SELECT DISTINCT d.to_date
      FROM diffs d
      JOIN datasets ds ON ds.id = d.dataset_id
      WHERE ds.category = ?
      ORDER BY d.to_date DESC
    `).all(category).map(r => r.to_date);
  }
  return db.prepare(
    'SELECT DISTINCT to_date FROM diffs ORDER BY to_date DESC'
  ).all().map(r => r.to_date);
}

// ─── Executive Reports ────────────────────────────────────────────

/**
 * Insert or replace an executive report for a given date.
 * @param {string} date - YYYY-MM-DD
 * @param {string} content - Markdown report content
 * @param {string} [modelUsed] - Model used for generation
 */
export function insertExecutiveReport(date, content, modelUsed = null) {
  const db = getDb();
  db.prepare(`
    INSERT INTO executive_reports (report_date, content, model_used)
    VALUES (?, ?, ?)
    ON CONFLICT(report_date) DO UPDATE SET
      content = excluded.content,
      model_used = excluded.model_used,
      created_at = datetime('now')
  `).run(date, content, modelUsed);
}

/**
 * Get the executive report for a given date, or the latest if date is omitted.
 * @param {string|null} [date] - YYYY-MM-DD, or null for latest
 * @returns {object|null} Report row or null
 */
export function getExecutiveReport(date = null) {
  const db = getDb();
  if (date) {
    return db.prepare(
      'SELECT * FROM executive_reports WHERE report_date = ?'
    ).get(date);
  }
  return db.prepare(
    'SELECT * FROM executive_reports ORDER BY report_date DESC LIMIT 1'
  ).get();
}

/**
 * Get all report dates (for dropdown).
 * @returns {string[]} Report dates YYYY-MM-DD, newest first
 */
export function getReportDates() {
  return getDb()
    .prepare('SELECT report_date FROM executive_reports ORDER BY report_date DESC')
    .all()
    .map((r) => r.report_date);
}

// ─── Retention ───────────────────────────────────────────────────

/**
 * Delete snapshots (and their rows) older than retentionDays.
 * Diffs and diff_items are kept — they are compact and needed for trends.
 *
 * @param {number} retentionDays - Delete snapshots older than this many days
 * @returns {{ deletedSnapshots: number, deletedRows: number }}
 */
export function pruneSnapshots(retentionDays) {
  const db = getDb();

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - retentionDays);
  const cutoffDate = cutoff.toISOString().slice(0, 10);

  const run = db.transaction(() => {
    // Find snapshots to delete
    const oldSnaps = db.prepare(
      'SELECT id FROM snapshots WHERE fetched_date < ?'
    ).all(cutoffDate);

    if (oldSnaps.length === 0) {
      return { deletedSnapshots: 0, deletedRows: 0 };
    }

    const snapIds = oldSnaps.map(s => s.id);

    // Delete rows for those snapshots
    let deletedRows = 0;
    const deleteRows = db.prepare('DELETE FROM snapshot_rows WHERE snapshot_id = ?');
    for (const id of snapIds) {
      const info = deleteRows.run(id);
      deletedRows += info.changes;
    }

    // Delete the snapshots themselves
    const deletedSnapshots = db.prepare(
      `DELETE FROM snapshots WHERE fetched_date < ?`
    ).run(cutoffDate).changes;

    return { deletedSnapshots, deletedRows };
  });

  return run();
}

// ─── Population Tracking ─────────────────────────────────────────

/**
 * Get population (row count) trend data from snapshots.
 * Returns daily row_count, api_total, and fetch_warnings for trend analysis.
 *
 * @param {number} days - Number of days to look back
 * @param {number|null} datasetId - Filter to a specific dataset
 * @param {string|null} category - Filter by dataset category
 * @returns {Array<{fetched_date: string, dataset_name: string, row_count: number, api_total: number|null, fetch_warnings: string|null}>}
 */
export function getPopulationTrend(days = 30, datasetId = null, category = null) {
  const db = getDb();
  const conditions = [];
  const params = [];

  if (datasetId) {
    conditions.push('s.dataset_id = ?');
    params.push(datasetId);
  }
  if (category) {
    conditions.push('ds.category = ?');
    params.push(category);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  return db.prepare(`
    SELECT
      s.fetched_date,
      ds.name AS dataset_name,
      s.dataset_id,
      s.row_count,
      s.api_total,
      s.fetch_warnings
    FROM snapshots s
    JOIN datasets ds ON ds.id = s.dataset_id
    ${where}
    ORDER BY s.fetched_date DESC, ds.name ASC
    LIMIT ?
  `).all(...params, days * 20); // generous limit for multiple datasets
}

/**
 * Pre-compute criticality and status counts for a vulnerability snapshot and store in vuln_distribution_cache.
 * Called from finalizeSnapshot when the snapshot's dataset category is 'vulnerability'.
 *
 * @param {number} snapshotId
 */
export function materializeVulnerabilityDistribution(snapshotId) {
  const db = getDb();
  const snap = db.prepare(
    'SELECT dataset_id, fetched_date FROM snapshots WHERE id = ?'
  ).get(snapshotId);
  if (!snap) return;

  const criticalityRows = db.prepare(`
    SELECT
      UPPER(
        COALESCE(
          NULLIF(TRIM(json_extract(sr.row_data, '$.criticality')), ''),
          NULLIF(TRIM(json_extract(sr.row_data, '$.severity')), ''),
          'unknown'
        )
      ) AS label,
      COUNT(*) AS count
    FROM snapshot_rows sr
    WHERE sr.snapshot_id = ?
    GROUP BY label
  `).all(snapshotId);

  const statusRows = db.prepare(`
    SELECT
      LOWER(
        COALESCE(
          NULLIF(TRIM(json_extract(sr.row_data, '$.status')), ''),
          'unknown'
        )
      ) AS label,
      COUNT(*) AS count
    FROM snapshot_rows sr
    WHERE sr.snapshot_id = ?
    GROUP BY label
  `).all(snapshotId);

  const insert = db.prepare(`
    INSERT INTO vuln_distribution_cache (fetched_date, dataset_id, dimension, label, count)
    VALUES (?, ?, ?, ?, ?)
  `);

  db.transaction(() => {
    db.prepare(
      'DELETE FROM vuln_distribution_cache WHERE fetched_date = ? AND dataset_id = ?'
    ).run(snap.fetched_date, snap.dataset_id);
    for (const row of criticalityRows) {
      insert.run(snap.fetched_date, snap.dataset_id, 'criticality', row.label, row.count);
    }
    for (const row of statusRows) {
      insert.run(snap.fetched_date, snap.dataset_id, 'status', row.label, row.count);
    }
  })();
}

/**
 * Return snapshot IDs for vulnerability snapshots that do not yet have vuln_distribution_cache entries.
 * Used by backfill-vuln-distribution CLI. Optionally limit to recent days.
 *
 * @param {number|null} days - If set, only snapshots with fetched_date >= (today - days)
 * @returns {number[]} snapshot IDs
 */
export function getVulnerabilitySnapshotIdsWithoutCache(days = null) {
  const db = getDb();
  let conditions =
    "ds.category = 'vulnerability' AND NOT EXISTS (SELECT 1 FROM vuln_distribution_cache v WHERE v.fetched_date = s.fetched_date AND v.dataset_id = s.dataset_id)";
  const params = [];
  if (days != null) {
    conditions += " AND s.fetched_date >= date('now', ?)";
    params.push(`-${days} days`);
  }
  const rows = db.prepare(
    `SELECT s.id FROM snapshots s JOIN datasets ds ON ds.id = s.dataset_id WHERE ${conditions}`
  ).all(...params);
  return rows.map((r) => r.id);
}

/**
 * Get vulnerability field distributions for a specific date.
 * Reads from vuln_distribution_cache when available (fast); falls back to aggregating
 * snapshot_rows for dates that were fetched before the cache existed.
 *
 * @param {string} date - Snapshot date (YYYY-MM-DD)
 * @param {string|null} category - Optional dataset category filter
 * @returns {{ criticality: Array<{dataset_id:number,label:string,count:number}>, status: Array<{dataset_id:number,label:string,count:number}> }}
 */
export function getVulnerabilityDistributions(date, category = null) {
  const db = getDb();
  let conditions = ['v.fetched_date = ?'];
  const params = [date];
  if (category) {
    conditions.push('ds.category = ?');
    params.push(category);
  }
  const where = conditions.join(' AND ');

  const cached = db.prepare(`
    SELECT v.dataset_id, v.dimension, v.label, v.count
    FROM vuln_distribution_cache v
    JOIN datasets ds ON ds.id = v.dataset_id
    WHERE ${where}
  `).all(...params);

  if (cached.length > 0) {
    const criticality = cached
      .filter((r) => r.dimension === 'criticality')
      .map((r) => ({ dataset_id: r.dataset_id, label: r.label, count: r.count }));
    const status = cached
      .filter((r) => r.dimension === 'status')
      .map((r) => ({ dataset_id: r.dataset_id, label: r.label, count: r.count }));
    return { criticality, status };
  }

  // Fallback: aggregate from snapshot_rows (slow for large datasets)
  const liveConditions = ['s.fetched_date = ?'];
  const liveParams = [date];
  if (category) {
    liveConditions.push('ds.category = ?');
    liveParams.push(category);
  }
  const liveWhere = `WHERE ${liveConditions.join(' AND ')}`;

  const criticality = db.prepare(`
    SELECT
      s.dataset_id,
      UPPER(
        COALESCE(
          NULLIF(TRIM(json_extract(sr.row_data, '$.criticality')), ''),
          NULLIF(TRIM(json_extract(sr.row_data, '$.severity')), ''),
          'unknown'
        )
      ) AS label,
      COUNT(*) AS count
    FROM snapshot_rows sr
    JOIN snapshots s ON s.id = sr.snapshot_id
    JOIN datasets ds ON ds.id = s.dataset_id
    ${liveWhere}
    GROUP BY s.dataset_id, label
  `).all(...liveParams);

  const status = db.prepare(`
    SELECT
      s.dataset_id,
      LOWER(
        COALESCE(
          NULLIF(TRIM(json_extract(sr.row_data, '$.status')), ''),
          'unknown'
        )
      ) AS label,
      COUNT(*) AS count
    FROM snapshot_rows sr
    JOIN snapshots s ON s.id = sr.snapshot_id
    JOIN datasets ds ON ds.id = s.dataset_id
    ${liveWhere}
    GROUP BY s.dataset_id, label
  `).all(...liveParams);

  return { criticality, status };
}
