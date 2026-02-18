import datasets from '../../config/datasets.mjs';
import { ensureDataset } from '../db/index.mjs';
import { log, warn, error } from '../lib/logger.mjs';
import {
  getLatestSnapshot,
  getPreviousSnapshot,
  getAddedRows,
  getRemovedRows,
  getModifiedRows,
  getUnchangedCount,
  insertDiff,
} from '../db/queries.mjs';

/**
 * Get today's date as YYYY-MM-DD.
 */
function today() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Deep-compare two values (handles nested objects/arrays).
 */
function deepEqual(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (typeof a !== typeof b) return false;

  if (typeof a === 'object') {
    if (Array.isArray(a) !== Array.isArray(b)) return false;

    if (Array.isArray(a)) {
      if (a.length !== b.length) return false;
      return a.every((val, i) => deepEqual(val, b[i]));
    }

    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    return keysA.every(key => deepEqual(a[key], b[key]));
  }

  return false;
}

/**
 * Find which top-level fields differ between two row objects.
 * @returns {string[]} List of field names that changed
 */
function findChangedFields(oldRow, newRow) {
  const allKeys = new Set([...Object.keys(oldRow), ...Object.keys(newRow)]);
  const changed = [];

  for (const key of allKeys) {
    if (!deepEqual(oldRow[key], newRow[key])) {
      changed.push(key);
    }
  }

  return changed;
}

/**
 * Build a slim field-level change map for a modified row.
 * Returns { fieldName: { old: value, new: value }, ... } for only the changed fields.
 */
function buildFieldChanges(oldRow, newRow, changedFields) {
  const changes = {};
  for (const field of changedFields) {
    changes[field] = {
      old: oldRow[field] ?? null,
      new: newRow[field] ?? null,
    };
  }
  return changes;
}

/**
 * Compute diff between two snapshots using SQL-based set operations.
 *
 * Instead of loading all rows into memory, we use SQL JOINs on row_key
 * and row_hash to identify added, removed, and modified rows.  Only the
 * changed rows are loaded into JS — unchanged rows are counted in SQL
 * without ever touching the JS heap.
 *
 * For modified rows, we parse both old and new JSON to compute field-level
 * changes.  Added/removed rows pass the raw JSON string through to the
 * DB without parsing, saving both CPU and memory.
 *
 * @param {number} oldSnapId - Previous snapshot ID
 * @param {number} newSnapId - Current snapshot ID
 * @returns {{ summary: object, items: Array }}
 */
function computeDiff(oldSnapId, newSnapId) {
  const items = [];

  // 1. Added rows — in new but not in old (raw JSON pass-through)
  const addedRows = getAddedRows(newSnapId, oldSnapId);
  for (const row of addedRows) {
    items.push({
      rowKey: row.row_key,
      changeType: 'added',
      rowData: row.row_data,       // raw JSON string — no parse needed
      fieldChanges: null,
      changedFields: null,
    });
  }

  // 2. Removed rows — in old but not in new (raw JSON pass-through)
  const removedRows = getRemovedRows(oldSnapId, newSnapId);
  for (const row of removedRows) {
    items.push({
      rowKey: row.row_key,
      changeType: 'removed',
      rowData: row.row_data,       // raw JSON string
      fieldChanges: null,
      changedFields: null,
    });
  }

  // 3. Modified rows — same key, different hash (parse for field diff)
  const modifiedRows = getModifiedRows(oldSnapId, newSnapId);
  for (const row of modifiedRows) {
    const oldData = JSON.parse(row.old_data);
    const newData = JSON.parse(row.new_data);
    const changedFields = findChangedFields(oldData, newData);

    if (changedFields.length > 0) {
      items.push({
        rowKey: row.row_key,
        changeType: 'modified',
        rowData: row.new_data,     // raw JSON string for storage
        fieldChanges: buildFieldChanges(oldData, newData, changedFields),
        changedFields,
      });
    }
    // If hash differs but deepEqual says same (shouldn't happen with
    // deterministic hashing, but guard against edge cases), skip it.
  }

  // 4. Unchanged count — SQL COUNT, no row data loaded
  const unchanged = getUnchangedCount(oldSnapId, newSnapId);

  const summary = {
    added: addedRows.length,
    removed: removedRows.length,
    modified: items.filter(i => i.changeType === 'modified').length,
    unchanged,
  };

  return { summary, items };
}

/**
 * Run diff for a single dataset between its most recent two snapshots.
 *
 * @param {object} datasetConfig - Entry from config/datasets.mjs
 * @param {string} [date] - The "current" date (default: today)
 * @returns {{ dataset: string, diffId: number, summary: object } | null}
 */
function diffDataset(datasetConfig, date) {
  const { name, endpoint, rowKey, category = 'platform' } = datasetConfig;
  const dataset = ensureDataset(name, endpoint, rowKey, category);

  // Get the current (today's) snapshot
  const currentSnap = getLatestSnapshot(dataset.id, date);
  if (!currentSnap) {
    log(`[diff] ${name}: no snapshot found for ${date}, skipping`);
    return null;
  }

  // Get the previous snapshot
  const previousSnap = getPreviousSnapshot(dataset.id, currentSnap.fetched_date);
  if (!previousSnap) {
    log(`[diff] ${name}: no previous snapshot to compare against (first run?)`);
    return null;
  }

  log(
    `[diff] ${name}: comparing ${previousSnap.fetched_date} (${previousSnap.row_count} rows) ` +
    `→ ${currentSnap.fetched_date} (${currentSnap.row_count} rows)`
  );

  // Compute diff using SQL-based set operations (memory-efficient)
  const { summary, items } = computeDiff(previousSnap.id, currentSnap.id);

  // Store diff
  const diffId = insertDiff(
    dataset.id,
    previousSnap.fetched_date,
    currentSnap.fetched_date,
    summary,
    items
  );

  log(
    `[diff] ${name}: +${summary.added} added, -${summary.removed} removed, ` +
    `~${summary.modified} modified, =${summary.unchanged} unchanged`
  );

  return {
    dataset: name,
    datasetId: dataset.id,
    diffId,
    fromDate: previousSnap.fetched_date,
    toDate: currentSnap.fetched_date,
    summary,
  };
}

/**
 * Run diffs for all configured datasets.
 *
 * @param {string} [date] - Override "current" date (default: today)
 * @returns {Array<{ dataset: string, diffId: number, summary: object }>}
 */
export function diffAllDatasets(date) {
  const diffDate = date || today();
  log(`\n[diff] Computing diffs for ${diffDate}`);
  log(`[diff] ${datasets.length} dataset(s) configured\n`);

  const results = [];

  for (const ds of datasets) {
    try {
      const result = diffDataset(ds, diffDate);
      if (result) {
        results.push(result);
      }
    } catch (err) {
      error(`[diff] ERROR processing ${ds.name}: ${err.message}`);
      results.push({ dataset: ds.name, error: err.message });
    }
  }

  const successCount = results.filter(r => !r.error && r.diffId).length;
  log(`\n[diff] Complete: ${successCount} diff(s) computed`);

  return results;
}
