import datasets from '../../config/datasets.mjs';
import { ensureDataset } from '../db/index.mjs';
import {
  getLatestSnapshot,
  getPreviousSnapshot,
  getSnapshotRows,
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
 * This avoids storing the entire old and new row objects in the DB.
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
 * Compute row-level diff between two snapshots.
 *
 * Storage strategy to minimize DB size:
 *   - added:    row_data = the new row. No old_data, no field_changes.
 *   - removed:  row_data = the old row. No new_data, no field_changes.
 *   - modified: row_data = the new (current) row for display context.
 *               field_changes = { field: { old, new } } for only changed fields.
 *               No full old_data blob.
 *
 * @param {Map<string, object>} oldRows - row_key -> row_data from previous snapshot
 * @param {Map<string, object>} newRows - row_key -> row_data from current snapshot
 * @returns {{ summary: object, items: Array }}
 */
function computeDiff(oldRows, newRows) {
  const items = [];
  let added = 0;
  let removed = 0;
  let modified = 0;
  let unchanged = 0;

  // Check for removed and modified rows
  for (const [key, oldData] of oldRows) {
    if (!newRows.has(key)) {
      removed++;
      items.push({
        rowKey: key,
        changeType: 'removed',
        rowData: oldData,
        fieldChanges: null,
        changedFields: null,
      });
    } else {
      const newData = newRows.get(key);
      const changedFields = findChangedFields(oldData, newData);

      if (changedFields.length > 0) {
        modified++;
        items.push({
          rowKey: key,
          changeType: 'modified',
          rowData: newData,
          fieldChanges: buildFieldChanges(oldData, newData, changedFields),
          changedFields,
        });
      } else {
        unchanged++;
      }
    }
  }

  // Check for added rows
  for (const [key, newData] of newRows) {
    if (!oldRows.has(key)) {
      added++;
      items.push({
        rowKey: key,
        changeType: 'added',
        rowData: newData,
        fieldChanges: null,
        changedFields: null,
      });
    }
  }

  return {
    summary: { added, removed, modified, unchanged },
    items,
  };
}

/**
 * Run diff for a single dataset between its most recent two snapshots.
 *
 * @param {object} datasetConfig - Entry from config/datasets.mjs
 * @param {string} [date] - The "current" date (default: today)
 * @returns {{ dataset: string, diffId: number, summary: object } | null}
 */
function diffDataset(datasetConfig, date) {
  const { name, endpoint, rowKey } = datasetConfig;
  const dataset = ensureDataset(name, endpoint, rowKey);

  // Get the current (today's) snapshot
  const currentSnap = getLatestSnapshot(dataset.id, date);
  if (!currentSnap) {
    console.log(`[diff] ${name}: no snapshot found for ${date}, skipping`);
    return null;
  }

  // Get the previous snapshot
  const previousSnap = getPreviousSnapshot(dataset.id, currentSnap.fetched_date);
  if (!previousSnap) {
    console.log(`[diff] ${name}: no previous snapshot to compare against (first run?)`);
    return null;
  }

  console.log(
    `[diff] ${name}: comparing ${previousSnap.fetched_date} (${previousSnap.row_count} rows) ` +
    `→ ${currentSnap.fetched_date} (${currentSnap.row_count} rows)`
  );

  // Load rows
  const oldRows = getSnapshotRows(previousSnap.id);
  const newRows = getSnapshotRows(currentSnap.id);

  // Compute diff
  const { summary, items } = computeDiff(oldRows, newRows);

  // Store diff
  const diffId = insertDiff(
    dataset.id,
    previousSnap.fetched_date,
    currentSnap.fetched_date,
    summary,
    items
  );

  console.log(
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
  console.log(`\n[diff] Computing diffs for ${diffDate}`);
  console.log(`[diff] ${datasets.length} dataset(s) configured\n`);

  const results = [];

  for (const ds of datasets) {
    try {
      const result = diffDataset(ds, diffDate);
      if (result) {
        results.push(result);
      }
    } catch (err) {
      console.error(`[diff] ERROR processing ${ds.name}: ${err.message}`);
      results.push({ dataset: ds.name, error: err.message });
    }
  }

  const successCount = results.filter(r => !r.error && r.diffId).length;
  console.log(`\n[diff] Complete: ${successCount} diff(s) computed`);

  return results;
}
