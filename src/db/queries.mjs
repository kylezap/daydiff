import { getDb } from './index.mjs';

// ─── Snapshot Queries ────────────────────────────────────────────

/**
 * Insert a snapshot and its rows inside a transaction.
 * @param {number} datasetId
 * @param {string} date - YYYY-MM-DD
 * @param {Array<{key: string, data: object}>} rows
 * @returns {{snapshotId: number, rowCount: number}}
 */
export function insertSnapshot(datasetId, date, rows) {
  const db = getDb();

  const insertSnap = db.prepare(`
    INSERT INTO snapshots (dataset_id, fetched_date, row_count)
    VALUES (?, ?, ?)
  `);

  const insertRow = db.prepare(`
    INSERT INTO snapshot_rows (snapshot_id, row_key, row_data)
    VALUES (?, ?, ?)
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

    const result = insertSnap.run(datasetId, date, rows.length);
    const snapshotId = result.lastInsertRowid;

    for (const row of rows) {
      insertRow.run(snapshotId, String(row.key), JSON.stringify(row.data));
    }

    return { snapshotId: Number(snapshotId), rowCount: rows.length };
  });

  return run();
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

// ─── Diff Queries ────────────────────────────────────────────────

/**
 * Insert a diff report and its items.
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
        item.rowData ? JSON.stringify(item.rowData) : null,
        item.fieldChanges ? JSON.stringify(item.fieldChanges) : null,
        item.changedFields ? JSON.stringify(item.changedFields) : null
      );
    }

    return diffId;
  });

  return run();
}

// ─── Dashboard API Queries ───────────────────────────────────────

/**
 * List all datasets.
 */
export function listDatasets() {
  return getDb().prepare('SELECT * FROM datasets ORDER BY name').all();
}

/**
 * List all diffs, optionally filtered by dataset.
 */
export function listDiffs(datasetId = null, limit = 90) {
  const db = getDb();
  if (datasetId) {
    return db.prepare(`
      SELECT d.*, ds.name as dataset_name
      FROM diffs d
      JOIN datasets ds ON ds.id = d.dataset_id
      WHERE d.dataset_id = ?
      ORDER BY d.to_date DESC
      LIMIT ?
    `).all(datasetId, limit);
  }
  return db.prepare(`
    SELECT d.*, ds.name as dataset_name
    FROM diffs d
    JOIN datasets ds ON ds.id = d.dataset_id
    ORDER BY d.to_date DESC
    LIMIT ?
  `).all(limit);
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
 * Get aggregate summary across all datasets for a given date.
 */
export function getSummaryForDate(date) {
  return getDb().prepare(`
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
 */
export function getTrend(days = 30, datasetId = null) {
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
 * Get all available diff dates.
 */
export function getAvailableDates() {
  return getDb().prepare(
    'SELECT DISTINCT to_date FROM diffs ORDER BY to_date DESC'
  ).all().map(r => r.to_date);
}
