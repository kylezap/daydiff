/**
 * Assertion Engine
 *
 * Evaluates configurable data-quality rules and records pass/fail results.
 * Called after each diff run to provide continuous quality monitoring.
 */

import { getDb } from '../db/index.mjs';
import { listDatasets, getPopulationTrend } from '../db/queries.mjs';
import {
  getFlappingRows,
  checkReferentialIntegrity,
  insertAssertionResult,
  clearAssertionResults,
} from './queries.mjs';
import assertionConfig from '../../config/assertions.mjs';

// ─── Check Implementations ───────────────────────────────────────

/**
 * population-drop: Fail if any dataset's row_count dropped by more than
 * `threshold` (as a fraction) compared to its previous snapshot.
 */
function checkPopulationDrop(date, opts) {
  const { threshold = 0.10, category = null } = opts;
  const datasets = listDatasets(category);
  const failures = [];

  for (const ds of datasets) {
    const db = getDb();
    // Get the two most recent snapshots for this dataset on or before date
    const snaps = db.prepare(`
      SELECT row_count, fetched_date FROM snapshots
      WHERE dataset_id = ? AND fetched_date <= ?
      ORDER BY fetched_date DESC
      LIMIT 2
    `).all(ds.id, date);

    if (snaps.length < 2) continue; // Not enough data to compare

    const [current, previous] = snaps;
    if (previous.row_count === 0) continue; // Can't compute a ratio

    const dropRatio = (previous.row_count - current.row_count) / previous.row_count;
    if (dropRatio > threshold) {
      failures.push({
        dataset: ds.name,
        previous: previous.row_count,
        current: current.row_count,
        dropPercent: (dropRatio * 100).toFixed(1),
      });
    }
  }

  if (failures.length === 0) {
    return { passed: true, message: 'All population counts within threshold' };
  }

  const msg = failures.map(
    f => `${f.dataset}: ${f.previous} → ${f.current} (−${f.dropPercent}%)`
  ).join('; ');

  return { passed: false, message: `Population drop exceeds ${threshold * 100}%: ${msg}`, details: failures };
}

/**
 * fetch-complete: Fail if any dataset's row_count doesn't match api_total
 * in the latest snapshot.
 */
function checkFetchComplete(date, opts) {
  const { category = null } = opts;
  const datasets = listDatasets(category);
  const db = getDb();
  const failures = [];

  for (const ds of datasets) {
    const snap = db.prepare(`
      SELECT row_count, api_total, fetch_warnings FROM snapshots
      WHERE dataset_id = ? AND fetched_date <= ?
      ORDER BY fetched_date DESC
      LIMIT 1
    `).get(ds.id, date);

    if (!snap) continue;

    // Check api_total mismatch
    if (snap.api_total !== null && snap.row_count !== snap.api_total) {
      failures.push({
        dataset: ds.name,
        row_count: snap.row_count,
        api_total: snap.api_total,
        fetch_warnings: snap.fetch_warnings,
      });
    }

    // Check for fetch warnings
    if (snap.fetch_warnings) {
      const existing = failures.find(f => f.dataset === ds.name);
      if (!existing) {
        failures.push({
          dataset: ds.name,
          row_count: snap.row_count,
          api_total: snap.api_total,
          fetch_warnings: snap.fetch_warnings,
        });
      }
    }
  }

  if (failures.length === 0) {
    return { passed: true, message: 'All fetches complete — row counts match API totals' };
  }

  const msg = failures.map(f => {
    const parts = [`${f.dataset}: fetched ${f.row_count}`];
    if (f.api_total !== null) parts.push(`expected ${f.api_total}`);
    if (f.fetch_warnings) parts.push(`warnings: ${f.fetch_warnings}`);
    return parts.join(', ');
  }).join('; ');

  return { passed: false, message: `Fetch incomplete: ${msg}`, details: failures };
}

/**
 * no-flapping: Fail if any row_key flaps (added then removed or vice versa)
 * more than maxFlaps times within windowDays.
 */
function checkNoFlapping(date, opts) {
  const { windowDays = 7, maxFlaps = 2, category = null } = opts;
  const datasets = listDatasets(category);
  const allFlapping = [];

  for (const ds of datasets) {
    const rows = getFlappingRows(ds.id, windowDays);
    const excessive = rows.filter(r => r.flap_count > maxFlaps);
    allFlapping.push(...excessive);
  }

  if (allFlapping.length === 0) {
    return { passed: true, message: `No excessive flapping detected (window: ${windowDays}d, max: ${maxFlaps})` };
  }

  const msg = `${allFlapping.length} row(s) flapping excessively`;
  return {
    passed: false,
    message: msg,
    details: allFlapping.slice(0, 20), // Cap detail rows
  };
}

/**
 * referential-integrity: Fail if vulnerabilities reference assets that
 * don't exist in platform snapshots.
 */
function checkReferentialIntegrityAssertion(date) {
  const orphans = checkReferentialIntegrity(date);

  if (orphans.length === 0) {
    return { passed: true, message: 'All vulnerability references resolve to known assets' };
  }

  const totalOrphaned = orphans.reduce((sum, o) => sum + o.vuln_count, 0);
  return {
    passed: false,
    message: `${orphans.length} orphaned reference(s) affecting ${totalOrphaned} vulnerabilities`,
    details: orphans.slice(0, 50),
  };
}

// ─── Check Dispatcher ────────────────────────────────────────────

const CHECK_HANDLERS = {
  'population-drop': checkPopulationDrop,
  'fetch-complete': checkFetchComplete,
  'no-flapping': checkNoFlapping,
  'referential-integrity': checkReferentialIntegrityAssertion,
};

// ─── Public API ──────────────────────────────────────────────────

/**
 * Run all configured assertions for a given date.
 * Results are stored in the assertion_results table.
 *
 * @param {string} date - YYYY-MM-DD
 * @param {Array} [config] - Override assertion config (useful for testing)
 * @returns {Array<{id: string, name: string, passed: boolean, message: string}>}
 */
export function runAssertions(date, config = assertionConfig) {
  // Clear previous results for this date (allows re-running)
  clearAssertionResults(date);

  const results = [];

  for (const assertion of config) {
    const handler = CHECK_HANDLERS[assertion.check];
    if (!handler) {
      console.warn(`[quality] Unknown check type: ${assertion.check}`);
      continue;
    }

    try {
      const result = handler(date, assertion);

      // Determine which dataset_id to associate (null for cross-dataset checks)
      let datasetId = null;
      if (assertion.datasetId) {
        datasetId = assertion.datasetId;
      }

      insertAssertionResult(
        assertion.id,
        datasetId,
        date,
        result.passed,
        result.message,
        result.details || null
      );

      results.push({
        id: assertion.id,
        name: assertion.name,
        passed: result.passed,
        message: result.message,
      });
    } catch (err) {
      const errorMsg = `Check failed with error: ${err.message}`;
      insertAssertionResult(assertion.id, null, date, false, errorMsg);
      results.push({
        id: assertion.id,
        name: assertion.name,
        passed: false,
        message: errorMsg,
      });
    }
  }

  return results;
}
