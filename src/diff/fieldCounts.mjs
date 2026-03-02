/**
 * Compute and persist field-level and nested-path change counts after a diff run.
 * Called from the diff engine when summary.modified > 0.
 */

import { getModifiedFieldCountsByDiff } from '../analysis/queries.mjs';
import { getDiffItemsPaginated, insertDiffFieldChangeCounts } from '../db/queries.mjs';
import { log } from '../lib/logger.mjs';

const NESTED_CAP_ROWS = 20000;

function diffValues(oldVal, newVal) {
  if (oldVal === newVal) return null;
  if (oldVal === null || newVal === null) return { old: oldVal, new: newVal };
  if (typeof oldVal !== 'object' || typeof newVal !== 'object') {
    return { old: oldVal, new: newVal };
  }
  if (Array.isArray(oldVal) || Array.isArray(newVal)) {
    return { old: oldVal, new: newVal };
  }
  const changes = {};
  const allKeys = new Set([...Object.keys(oldVal), ...Object.keys(newVal)]);
  for (const key of allKeys) {
    const o = oldVal[key];
    const n = newVal[key];
    if (JSON.stringify(o) !== JSON.stringify(n)) {
      if (typeof o === 'object' && o !== null && typeof n === 'object' && n !== null && !Array.isArray(o) && !Array.isArray(n)) {
        const nested = diffValues(o, n);
        if (nested && Object.keys(nested).length) changes[key] = nested;
      } else {
        changes[key] = { old: o, new: n };
      }
    }
  }
  return Object.keys(changes).length ? changes : null;
}

function recordChangePaths(delta, pathCounts, pathPrefix = '') {
  if (!delta || typeof delta !== 'object') return;
  for (const [key, val] of Object.entries(delta)) {
    const path = pathPrefix ? `${pathPrefix}.${key}` : key;
    if (val && typeof val === 'object' && 'old' in val && 'new' in val) {
      pathCounts[path] = (pathCounts[path] || 0) + 1;
    } else if (val && typeof val === 'object' && !Array.isArray(val)) {
      recordChangePaths(val, pathCounts, path);
    }
  }
}

/**
 * Aggregate nested path counts from modified diff_items (field_changes JSON).
 * Caps at NESTED_CAP_ROWS to avoid blocking on huge diffs.
 * @param {number} diffId
 * @param {number} modifiedCount
 * @returns {Array<{field_path: string, change_count: number}>}
 */
function aggregateNestedPathCounts(diffId, modifiedCount) {
  const pathCounts = {};
  const cap = Math.min(modifiedCount, NESTED_CAP_ROWS);
  let offset = 0;
  const limit = 500;

  while (offset < cap) {
    const { rows } = getDiffItemsPaginated(diffId, {
      offset,
      limit,
      changeType: 'modified',
    });
    if (rows.length === 0) break;

    for (const item of rows) {
      if (!item.field_changes) continue;
      let fc;
      try {
        fc = typeof item.field_changes === 'string' ? JSON.parse(item.field_changes) : item.field_changes;
      } catch {
        continue;
      }
      if (!fc || typeof fc !== 'object') continue;
      for (const [fieldName, change] of Object.entries(fc)) {
        if (!change || typeof change !== 'object') continue;
        const delta = diffValues(change.old ?? {}, change.new ?? {});
        if (delta) recordChangePaths(delta, pathCounts, fieldName);
      }
    }

    offset += rows.length;
    if (rows.length < limit) break;
  }

  if (modifiedCount > NESTED_CAP_ROWS) {
    log(`[fieldCounts] Nested path aggregation capped at ${NESTED_CAP_ROWS} of ${modifiedCount} modified rows`);
  }

  return Object.entries(pathCounts)
    .filter(([path]) => path.includes('.'))
    .sort((a, b) => b[1] - a[1])
    .map(([field_path, change_count]) => ({ field_path, change_count }));
}

/**
 * Compute top-level and nested field/path change counts for a diff and persist to diff_field_change_counts.
 * Call after insertDiff when summary.modified > 0.
 *
 * @param {number} diffId - diff id just inserted
 * @param {number} modifiedCount - summary.modified for this diff
 */
export function computeAndStoreFieldChangeCounts(diffId, modifiedCount) {
  const topLevel = getModifiedFieldCountsByDiff(diffId);
  const topLevelRows = topLevel.map(({ field_name, change_count }) => ({
    field_path: field_name,
    change_count,
  }));

  const nestedRows = aggregateNestedPathCounts(diffId, modifiedCount);
  const allRows = [...topLevelRows, ...nestedRows];

  if (allRows.length > 0) {
    insertDiffFieldChangeCounts(diffId, allRows);
    log(`[fieldCounts] Stored ${topLevelRows.length} top-level + ${nestedRows.length} nested paths for diff ${diffId}`);
  }
}
