#!/usr/bin/env node
/**
 * Analyze providerSpecificDetails JSON in today's Resources modified diff items.
 * Finds structure (keys), which sub-fields change, and value patterns.
 */
import { getDb } from '../src/db/index.mjs';
import { listDatasets, getSummaryForDate, getDiffItemsPaginated } from '../src/db/queries.mjs';

const TODAY = new Date().toISOString().slice(0, 10);
const BATCH = 2000;
const MAX_SAMPLES = 15000; // cap to keep runtime reasonable

/**
 * Recursively collect all key paths (e.g. "cpu", "nested.count") in an object.
 */
function collectPaths(obj, prefix = '') {
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
 * Return object with only the keys that differ between old and new (one level).
 * For nested objects, recurse or compare JSON string if different.
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

function main() {
  getDb();

  const datasets = listDatasets();
  const resources = datasets.find((d) => d.name === 'Resources');
  if (!resources) {
    console.error('Resources dataset not found.');
    process.exit(1);
  }

  const summary = getSummaryForDate(TODAY);
  const resourcesSummary = summary.find((s) => s.dataset_name === 'Resources');
  if (!resourcesSummary) {
    console.error(`No diff for Resources on ${TODAY}.`);
    process.exit(1);
  }

  const { diff_id, modified_count } = resourcesSummary;
  console.log(`\n=== providerSpecificDetails in Resources modified rows (${TODAY}) ===\n`);
  console.log(`Total modified: ${modified_count}\n`);

  let offset = 0;
  let totalWithProviderDetails = 0;
  const allTopLevelKeys = new Set();
  const pathCounts = {}; // path -> count of rows where it appears
  const changePathCounts = {}; // path -> count where this path's value changed
  const changeSamples = []; // { path, old, new } up to N per path
  const SAMPLES_PER_PATH = 5;
  const pathSampleCount = {};

  while (offset < Math.min(modified_count, MAX_SAMPLES)) {
    const { rows } = getDiffItemsPaginated(diff_id, {
      offset,
      limit: BATCH,
      changeType: 'modified',
    });
    if (rows.length === 0) break;

    for (const item of rows) {
      const changedFields = item.changed_fields ? JSON.parse(item.changed_fields) : [];
      if (!changedFields.includes('providerSpecificDetails')) continue;

      totalWithProviderDetails++;
      let oldDetail = null;
      let newDetail = null;
      if (item.field_changes) {
        const fc = JSON.parse(item.field_changes);
        const ps = fc.providerSpecificDetails;
        if (ps && typeof ps === 'object') {
          oldDetail = ps.old ?? null;
          newDetail = ps.new ?? null;
        }
      }

      // If field_changes had string "[object Object]", we need row_data for new; old is lost in storage
      if (oldDetail === undefined && item.row_data) {
        try {
          const row = JSON.parse(item.row_data);
          newDetail = row.providerSpecificDetails ?? null;
        } catch (_) {}
      }

      if (newDetail && typeof newDetail === 'object') {
        for (const k of Object.keys(newDetail)) allTopLevelKeys.add(k);
        for (const p of collectPaths(newDetail)) {
          pathCounts[p] = (pathCounts[p] || 0) + 1;
        }
      }
      if (oldDetail && typeof oldDetail === 'object') {
        for (const k of Object.keys(oldDetail)) allTopLevelKeys.add(k);
        for (const p of collectPaths(oldDetail)) {
          pathCounts[p] = (pathCounts[p] || 0) + 1;
        }
      }

      const delta = diffValues(oldDetail || {}, newDetail || {});
      if (delta && typeof delta === 'object') {
        function recordChanges(obj, pathPrefix = '') {
          for (const [key, val] of Object.entries(obj)) {
            const path = pathPrefix ? `${pathPrefix}.${key}` : key;
            if (val && typeof val === 'object' && 'old' in val && 'new' in val) {
              changePathCounts[path] = (changePathCounts[path] || 0) + 1;
              if ((pathSampleCount[path] || 0) < SAMPLES_PER_PATH) {
                changeSamples.push({ path, old: val.old, new: val.new });
                pathSampleCount[path] = (pathSampleCount[path] || 0) + 1;
              }
            } else if (val && typeof val === 'object' && !Array.isArray(val)) {
              recordChanges(val, path);
            }
          }
        }
        recordChanges(delta);
      }
    }

    offset += rows.length;
    if (rows.length < BATCH) break;
  }

  console.log(`--- Rows where providerSpecificDetails changed (sampled) ---`);
  console.log(`  ${totalWithProviderDetails} of ${offset} modified rows had providerSpecificDetails change\n`);

  console.log(`--- Top-level keys in providerSpecificDetails ---`);
  for (const k of [...allTopLevelKeys].sort()) {
    console.log(`  ${k}`);
  }

  console.log(`\n--- All key paths (nested) and how often they appear ---`);
  for (const [path, count] of Object.entries(pathCounts).sort((a, b) => b[1] - a[1])) {
    const changeCount = changePathCounts[path] || 0;
    const tag = changeCount ? ` [CHANGED in ${changeCount}]` : '';
    console.log(`  ${path}: ${count}${tag}`);
  }

  console.log(`\n--- Paths that actually changed (old → new), with sample values ---`);
  const sortedChangePaths = Object.entries(changePathCounts).sort((a, b) => b[1] - a[1]);
  for (const [path, count] of sortedChangePaths) {
    console.log(`  ${path} (${count} rows):`);
    const samples = changeSamples.filter((s) => s.path === path).slice(0, 4);
    for (const s of samples) {
      const oldStr = typeof s.old === 'object' ? JSON.stringify(s.old) : String(s.old);
      const newStr = typeof s.new === 'object' ? JSON.stringify(s.new) : String(s.new);
      const truncate = (x) => (x.length > 70 ? x.slice(0, 67) + '...' : x);
      console.log(`    ${truncate(oldStr)}  →  ${truncate(newStr)}`);
    }
    console.log('');
  }

  // One full example of providerSpecificDetails (new) from row_data
  console.log(`--- Full example providerSpecificDetails (one row_data) ---`);
  offset = 0;
  for (;;) {
    const { rows } = getDiffItemsPaginated(diff_id, { offset, limit: 100, changeType: 'modified' });
    if (rows.length === 0) break;
    for (const item of rows) {
      if (!item.changed_fields || !item.changed_fields.includes('providerSpecificDetails')) continue;
      try {
        const row = JSON.parse(item.row_data);
        if (row.providerSpecificDetails) {
          console.log(JSON.stringify(row.providerSpecificDetails, null, 2));
          return;
        }
      } catch (_) {}
    }
    offset += 100;
  }
  console.log('  (none found)\n');
}

main();
