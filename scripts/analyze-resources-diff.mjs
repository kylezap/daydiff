#!/usr/bin/env node
/**
 * Analyze today's diff for the Resources dataset.
 * Summarizes change types, field-level patterns, and value distributions.
 */
import { getDb } from '../src/db/index.mjs';
import {
  listDatasets,
  getSummaryForDate,
  getDiffItems,
  getDiffItemsPaginated,
} from '../src/db/queries.mjs';
import { getFieldStability } from '../src/analysis/queries.mjs';

const TODAY = new Date().toISOString().slice(0, 10);

function main() {
  const db = getDb();

  // Resolve Resources dataset and today's diff
  const datasets = listDatasets();
  const resources = datasets.find((d) => d.name === 'Resources');
  if (!resources) {
    console.error('Resources dataset not found.');
    process.exit(1);
  }

  const summary = getSummaryForDate(TODAY);
  const resourcesSummary = summary.find((s) => s.dataset_name === 'Resources');
  if (!resourcesSummary) {
    console.error(`No diff for Resources on ${TODAY}. Run fetch + diff first.`);
    process.exit(1);
  }

  const { diff_id, from_date, to_date, added_count, removed_count, modified_count, unchanged_count } =
    resourcesSummary;
  console.log(`\n=== Resources diff for ${to_date} (${from_date} → ${to_date}) ===\n`);
  console.log(`Summary: +${added_count} added, -${removed_count} removed, ~${modified_count} modified, =${unchanged_count} unchanged\n`);

  if (modified_count === 0) {
    console.log('No modified records to analyze.');
    return;
  }

  // Field stability for Resources, 1 day (today)
  const fieldStability = getFieldStability(resources.id, 1);
  console.log('--- Fields that changed (modified rows, today) ---');
  for (const row of fieldStability) {
    console.log(`  ${row.field_name}: ${row.change_count} changes`);
  }

  // Paginate through all modified items to avoid loading everything at once
  const BATCH = 2000;
  let offset = 0;
  let total = 0;
  const fieldCounts = {};
  const changeTypeByField = {}; // field -> { oldVal -> { newVal -> count } }
  const rowDataSamples = []; // first 5 row_data for structure
  const rowDataKeys = new Set();

  for (;;) {
    const { rows, total: totalItems } = getDiffItemsPaginated(diff_id, {
      offset,
      limit: BATCH,
      changeType: 'modified',
    });
    total = totalItems;
    if (rows.length === 0) break;

    for (const item of rows) {
      const changedFields = item.changed_fields ? JSON.parse(item.changed_fields) : [];
      for (const f of changedFields) {
        fieldCounts[f] = (fieldCounts[f] || 0) + 1;
      }

      if (item.field_changes) {
        const fc = JSON.parse(item.field_changes);
        for (const [field, { old: oldVal, new: newVal }] of Object.entries(fc)) {
          const oldStr = oldVal === null ? 'null' : String(oldVal);
          const newStr = newVal === null ? 'null' : String(newVal);
          if (!changeTypeByField[field]) changeTypeByField[field] = {};
          if (!changeTypeByField[field][oldStr]) changeTypeByField[field][oldStr] = {};
          changeTypeByField[field][oldStr][newStr] = (changeTypeByField[field][oldStr][newStr] || 0) + 1;
        }
      }

      if (item.row_data && rowDataSamples.length < 5) {
        try {
          const data = JSON.parse(item.row_data);
          for (const k of Object.keys(data)) rowDataKeys.add(k);
          rowDataSamples.push(data);
        } catch (_) {}
      }
    }

    offset += rows.length;
    if (rows.length < BATCH) break;
  }

  console.log('\n--- Field change counts (modified rows) ---');
  const sortedFields = Object.entries(fieldCounts).sort((a, b) => b[1] - a[1]);
  for (const [field, count] of sortedFields) {
    console.log(`  ${field}: ${count}`);
  }

  console.log('\n--- Value transition patterns (top per field) ---');
  for (const [field, transitions] of Object.entries(changeTypeByField)) {
    const flat = [];
    for (const [oldVal, targets] of Object.entries(transitions)) {
      for (const [newVal, c] of Object.entries(targets)) {
        flat.push({ oldVal, newVal, count: c });
      }
    }
    flat.sort((a, b) => b.count - a.count);
    const top = flat.slice(0, 5);
    console.log(`  ${field}:`);
    for (const t of top) {
      console.log(`    "${t.oldVal}" → "${t.newVal}" (${t.count})`);
    }
  }

  if (rowDataSamples.length > 0) {
    console.log('\n--- Sample row_data keys (from modified rows) ---');
    console.log(`  ${[...rowDataKeys].sort().join(', ')}`);
    // Optional: group modified rows by a likely "type" or "applicationId" if present
    const byType = {};
    const byApp = {};
    offset = 0;
    for (;;) {
      const { rows } = getDiffItemsPaginated(diff_id, {
        offset,
        limit: BATCH,
        changeType: 'modified',
      });
      if (rows.length === 0) break;
      for (const item of rows) {
        try {
          const data = JSON.parse(item.row_data);
          const type = data.type ?? data.resourceType ?? 'unknown';
          byType[type] = (byType[type] || 0) + 1;
          const app = data.applicationId ?? data.application ?? 'none';
          byApp[app] = (byApp[app] || 0) + 1;
        } catch (_) {}
      }
      offset += rows.length;
      if (rows.length < BATCH) break;
    }
    if (Object.keys(byType).length > 0) {
      console.log('\n--- Modified rows by type/resourceType ---');
      for (const [k, v] of Object.entries(byType).sort((a, b) => b[1] - a[1])) {
        console.log(`  ${k}: ${v}`);
      }
    }
    if (Object.keys(byApp).length > 0 && Object.keys(byApp).length <= 30) {
      console.log('\n--- Modified rows by applicationId (sample) ---');
      const entries = Object.entries(byApp).sort((a, b) => b[1] - a[1]).slice(0, 15);
      for (const [k, v] of entries) {
        console.log(`  ${k}: ${v}`);
      }
    }
  }

  console.log('\n--- Done ---\n');
}

main();
