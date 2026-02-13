import { getDb } from '../db/index.mjs';

// ─── Flapping Detection ──────────────────────────────────────────

/**
 * Find row_keys that appear as both 'added' and 'removed' within a rolling
 * window — a strong signal of upstream data instability.
 *
 * @param {number|null} datasetId - Filter to a specific dataset (null = all)
 * @param {number} windowDays - How many days to look back
 * @returns {Array<{row_key: string, dataset_name: string, flap_count: number, transitions: string}>}
 */
export function getFlappingRows(datasetId = null, windowDays = 7) {
  const db = getDb();

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - windowDays);
  const cutoffDate = cutoff.toISOString().slice(0, 10);

  const conditions = ['d.to_date >= ?'];
  const params = [cutoffDate];

  if (datasetId) {
    conditions.push('d.dataset_id = ?');
    params.push(datasetId);
  }

  const where = conditions.join(' AND ');

  // Find row_keys with both 'added' and 'removed' entries in the window
  return db.prepare(`
    SELECT
      di.row_key,
      ds.name AS dataset_name,
      d.dataset_id,
      COUNT(*) AS flap_count,
      GROUP_CONCAT(di.change_type || ':' || d.to_date, '; ') AS transitions
    FROM diff_items di
    JOIN diffs d ON d.id = di.diff_id
    JOIN datasets ds ON ds.id = d.dataset_id
    WHERE ${where}
      AND di.change_type IN ('added', 'removed')
    GROUP BY d.dataset_id, di.row_key
    HAVING COUNT(DISTINCT di.change_type) = 2
    ORDER BY flap_count DESC
    LIMIT 200
  `).all(...params);
}

// ─── Field Stability ─────────────────────────────────────────────

/**
 * Aggregate which fields change most frequently across recent diffs.
 * Uses SQLite json_each to expand the changed_fields JSON arrays.
 *
 * @param {number|null} datasetId - Filter to a specific dataset
 * @param {number} days - How many days to look back
 * @returns {Array<{field_name: string, change_count: number, dataset_name: string}>}
 */
export function getFieldStability(datasetId = null, days = 30) {
  const db = getDb();

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffDate = cutoff.toISOString().slice(0, 10);

  const conditions = ['d.to_date >= ?', 'di.change_type = ?', 'di.changed_fields IS NOT NULL'];
  const params = [cutoffDate, 'modified'];

  if (datasetId) {
    conditions.push('d.dataset_id = ?');
    params.push(datasetId);
  }

  const where = conditions.join(' AND ');

  return db.prepare(`
    SELECT
      j.value AS field_name,
      COUNT(*) AS change_count,
      ds.name AS dataset_name,
      d.dataset_id
    FROM diff_items di
    JOIN diffs d ON d.id = di.diff_id
    JOIN datasets ds ON ds.id = d.dataset_id
    JOIN json_each(di.changed_fields) j
    WHERE ${where}
    GROUP BY d.dataset_id, j.value
    ORDER BY change_count DESC
    LIMIT 50
  `).all(...params);
}

// ─── Source-System Segmentation ──────────────────────────────────

/**
 * Break down diff changes by originatingSystem and scanType,
 * extracted from the row_data JSON via json_extract.
 *
 * @param {number|null} datasetId - Filter to a specific dataset
 * @param {string|null} date - Specific date (null = latest)
 * @returns {Array<{source: string, scan_type: string, change_type: string, cnt: number}>}
 */
export function getSourceSegments(datasetId = null, date = null) {
  const db = getDb();

  const conditions = [];
  const params = [];

  if (datasetId) {
    conditions.push('d.dataset_id = ?');
    params.push(datasetId);
  }
  if (date) {
    conditions.push('d.to_date = ?');
    params.push(date);
  } else {
    // Default to the latest date
    conditions.push('d.to_date = (SELECT MAX(to_date) FROM diffs)');
  }

  // Only meaningful for vulnerability datasets
  conditions.push("ds.category = 'vulnerability'");

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  return db.prepare(`
    SELECT
      COALESCE(json_extract(di.row_data, '$.originatingSystem'), 'unknown') AS source,
      COALESCE(json_extract(di.row_data, '$.scanType'), 'unknown') AS scan_type,
      di.change_type,
      COUNT(*) AS cnt
    FROM diff_items di
    JOIN diffs d ON d.id = di.diff_id
    JOIN datasets ds ON ds.id = d.dataset_id
    ${where}
    GROUP BY source, scan_type, di.change_type
    ORDER BY source, scan_type, di.change_type
  `).all(...params);
}

// ─── Referential Integrity ───────────────────────────────────────

/**
 * Cross-check vulnerableId values in vulnerability snapshots against
 * row_keys in platform snapshots (applications, components, repositories).
 *
 * Returns orphaned references — vulnerableIds that don't match any
 * known platform asset.
 *
 * @param {string|null} date - Date to check (null = latest)
 * @returns {Array<{vulnerable_id: string, dataset_name: string, vuln_count: number}>}
 */
export function checkReferentialIntegrity(date = null) {
  const db = getDb();

  // Determine the check date
  const checkDate = date || db.prepare(
    'SELECT MAX(fetched_date) AS d FROM snapshots'
  ).get()?.d;

  if (!checkDate) return [];

  // Get all platform snapshot IDs for this date
  const platformSnaps = db.prepare(`
    SELECT s.id AS snapshot_id, ds.name AS dataset_name
    FROM snapshots s
    JOIN datasets ds ON ds.id = s.dataset_id
    WHERE s.fetched_date = ? AND ds.category = 'platform'
  `).all(checkDate);

  if (platformSnaps.length === 0) return [];

  // Collect all platform row_keys into a set
  const platformKeys = new Set();
  for (const snap of platformSnaps) {
    const keys = db.prepare(
      'SELECT row_key FROM snapshot_rows WHERE snapshot_id = ?'
    ).all(snap.snapshot_id);
    for (const k of keys) {
      platformKeys.add(k.row_key);
    }
  }

  // Get vulnerability snapshots for this date
  const vulnSnaps = db.prepare(`
    SELECT s.id AS snapshot_id, ds.name AS dataset_name
    FROM snapshots s
    JOIN datasets ds ON ds.id = s.dataset_id
    WHERE s.fetched_date = ? AND ds.category = 'vulnerability'
  `).all(checkDate);

  if (vulnSnaps.length === 0) return [];

  // Check each vuln snapshot for orphaned vulnerableId references
  const orphans = [];
  for (const snap of vulnSnaps) {
    const vulnIds = db.prepare(`
      SELECT
        json_extract(row_data, '$.vulnerableId') AS vulnerable_id,
        COUNT(*) AS vuln_count
      FROM snapshot_rows
      WHERE snapshot_id = ?
        AND json_extract(row_data, '$.vulnerableId') IS NOT NULL
      GROUP BY vulnerable_id
    `).all(snap.snapshot_id);

    for (const row of vulnIds) {
      if (row.vulnerable_id && !platformKeys.has(row.vulnerable_id)) {
        orphans.push({
          vulnerable_id: row.vulnerable_id,
          dataset_name: snap.dataset_name,
          vuln_count: row.vuln_count,
        });
      }
    }
  }

  return orphans;
}

// ─── Assertion CRUD ──────────────────────────────────────────────

/**
 * Store an assertion result.
 */
export function insertAssertionResult(assertionId, datasetId, date, passed, message, details = null) {
  const db = getDb();
  return db.prepare(`
    INSERT INTO assertion_results (assertion_id, dataset_id, checked_date, passed, message, details)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    assertionId,
    datasetId,
    date,
    passed ? 1 : 0,
    message,
    details ? JSON.stringify(details) : null
  );
}

/**
 * Get assertion results for a specific date.
 */
export function getAssertionResults(date = null) {
  const db = getDb();

  if (!date) {
    // Get latest date with results
    const latest = db.prepare(
      'SELECT MAX(checked_date) AS d FROM assertion_results'
    ).get();
    date = latest?.d;
  }

  if (!date) return [];

  return db.prepare(`
    SELECT
      ar.*,
      ds.name AS dataset_name
    FROM assertion_results ar
    LEFT JOIN datasets ds ON ds.id = ar.dataset_id
    WHERE ar.checked_date = ?
    ORDER BY ar.passed ASC, ar.assertion_id
  `).all(date);
}

/**
 * Get assertion pass/fail history for trend display.
 */
export function getAssertionHistory(assertionId, days = 30) {
  const db = getDb();

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffDate = cutoff.toISOString().slice(0, 10);

  return db.prepare(`
    SELECT checked_date, passed, message
    FROM assertion_results
    WHERE assertion_id = ? AND checked_date >= ?
    ORDER BY checked_date DESC
  `).all(assertionId, cutoffDate);
}

/**
 * Clear assertion results for a given date (for re-running).
 */
export function clearAssertionResults(date) {
  const db = getDb();
  return db.prepare('DELETE FROM assertion_results WHERE checked_date = ?').run(date);
}
