/**
 * Pattern analysis for executive report: nested JSON field changes and added/removed hints.
 */

import { getDiffItemsPaginated } from '../db/queries.mjs';

const MAX_MODIFIED_FOR_NESTED = 2000;
const MAX_ROWS_NESTED = 500;
const MAX_NESTED_PATHS = 15;
const ADDED_REMOVED_SAMPLE = 200;
const TOP_KEYS_LIMIT = 10;
const VALUE_DISTRIBUTION_KEYS = ['status', 'severity', 'criticality'];

/**
 * Recursively collect key paths (e.g. "cpu", "nested.count") in an object.
 * @param {object} obj
 * @param {string} [prefix='']
 * @returns {Set<string>}
 */
export function collectPaths(obj, prefix = '') {
  const paths = new Set();
  if (obj === null || typeof obj !== 'object') return paths;
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    paths.add(path);
    if (v !== null && typeof v === 'object' && !Array.isArray(v) && typeof v[0] !== 'number') {
      collectPaths(v, path).forEach((p) => paths.add(p));
    }
  }
  return paths;
}

/**
 * Nested diff: return object with only keys that differ. For leaf changes, { old, new }.
 * For nested objects, recurse.
 * @param {*} oldVal
 * @param {*} newVal
 * @returns {object|null}
 */
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

/**
 * Record changed paths from a field_changes delta (recursed) into pathCounts.
 * @param {object} delta - output of diffValues (nested { old, new } or nested objects)
 * @param {Record<string, number>} pathCounts - mutable path -> count
 * @param {string} [pathPrefix='']
 */
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
 * For a single diff, aggregate nested paths that changed in modified rows (from field_changes).
 * Only runs when modified_count < MAX_MODIFIED_FOR_NESTED; caps at MAX_ROWS_NESTED rows.
 * Returns top MAX_NESTED_PATHS paths by change count.
 *
 * @param {number} diffId
 * @param {number} modifiedCount - total modified count for this diff
 * @returns {Array<{path: string, change_count: number}>}
 */
export function getNestedPathPatterns(diffId, modifiedCount) {
  if (modifiedCount >= MAX_MODIFIED_FOR_NESTED) return [];
  const pathCounts = {};
  let offset = 0;
  const limit = 100;

  while (offset < MAX_ROWS_NESTED) {
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
      for (const [_field, change] of Object.entries(fc)) {
        if (!change || typeof change !== 'object') continue;
        const oldVal = change.old;
        const newVal = change.new;
        const delta = diffValues(oldVal ?? {}, newVal ?? {});
        if (delta) recordChangePaths(delta, pathCounts);
      }
    }

    offset += rows.length;
    if (rows.length < limit) break;
  }

  const sorted = Object.entries(pathCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_NESTED_PATHS);
  return sorted.map(([path, change_count]) => ({ path, change_count }));
}

/**
 * For added or removed items, sample row_data to get key presence counts and optional value distribution.
 *
 * @param {number} diffId
 * @param {'added'|'removed'} changeType
 * @returns {{ keys_present: Array<{key: string, count: number}>, value_distribution?: Record<string, Record<string, number>> }}
 */
export function getAddedRemovedPatterns(diffId, changeType) {
  const keysPresent = {};
  const valueDist = {};
  for (const k of VALUE_DISTRIBUTION_KEYS) {
    valueDist[k] = {};
  }

  let offset = 0;
  const limit = 100;
  let totalSampled = 0;

  while (totalSampled < ADDED_REMOVED_SAMPLE) {
    const { rows } = getDiffItemsPaginated(diffId, {
      offset,
      limit,
      changeType,
    });
    if (rows.length === 0) break;

    for (const item of rows) {
      if (totalSampled >= ADDED_REMOVED_SAMPLE) break;
      if (!item.row_data) continue;
      let data;
      try {
        data = typeof item.row_data === 'string' ? JSON.parse(item.row_data) : item.row_data;
      } catch {
        continue;
      }
      if (!data || typeof data !== 'object') continue;
      totalSampled++;

      for (const key of Object.keys(data)) {
        keysPresent[key] = (keysPresent[key] || 0) + 1;
        if (VALUE_DISTRIBUTION_KEYS.includes(key)) {
          const val = data[key];
          const str = val != null ? String(val) : 'null';
          valueDist[key][str] = (valueDist[key][str] || 0) + 1;
        }
      }
    }

    offset += rows.length;
    if (rows.length < limit) break;
  }

  const keys_present = Object.entries(keysPresent)
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_KEYS_LIMIT)
    .map(([key, count]) => ({ key, count }));

  const value_distribution = {};
  for (const k of VALUE_DISTRIBUTION_KEYS) {
    if (Object.keys(valueDist[k]).length > 0) {
      value_distribution[k] = valueDist[k];
    }
  }

  const result = { keys_present };
  if (Object.keys(value_distribution).length > 0) {
    result.value_distribution = value_distribution;
  }
  return result;
}
