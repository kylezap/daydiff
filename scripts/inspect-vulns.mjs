#!/usr/bin/env node
/**
 * Inspect vulnerability snapshots and diffs to compare datasets and find patterns.
 * Run from repo root: node scripts/inspect-vulns.mjs
 */
import { getDb } from '../src/db/index.mjs';
import { getModifiedFieldCountsByDiff } from '../src/analysis/queries.mjs';
import { getDiffItemsPaginated } from '../src/db/queries.mjs';

const db = getDb();

// 1) Vulnerability datasets
const vulnDatasets = db.prepare(`
  SELECT id, name FROM datasets WHERE category = 'vulnerability' ORDER BY name
`).all();
console.log('=== Vulnerability datasets ===');
console.table(vulnDatasets);

// 2) Snapshot row_count + api_total for last 14 days per vuln dataset
console.log('\n=== Snapshots (row_count vs api_total) by dataset, last 14 days ===');
const snapshots = db.prepare(`
  SELECT s.fetched_date, ds.id AS dataset_id, ds.name AS dataset_name,
         s.row_count, s.api_total, s.fetch_warnings
  FROM snapshots s
  JOIN datasets ds ON ds.id = s.dataset_id
  WHERE ds.category = 'vulnerability'
  AND s.fetched_date >= date('now', '-14 days')
  ORDER BY ds.name, s.fetched_date DESC
`).all();

const byDataset = {};
for (const row of snapshots) {
  const key = row.dataset_name;
  if (!byDataset[key]) byDataset[key] = [];
  byDataset[key].push(row);
}
for (const [name, rows] of Object.entries(byDataset)) {
  console.log(`\n--- ${name} ---`);
  for (const r of rows) {
    const gap = r.api_total != null ? r.api_total - r.row_count : null;
    const gapStr = gap != null ? ` (gap: ${gap})` : '';
    console.log(`  ${r.fetched_date}  row_count=${r.row_count}  api_total=${r.api_total ?? 'null'}${gapStr}  warnings=${r.fetch_warnings ?? '-'}`);
  }
}

// 3) Recent diffs for vulnerability (added/removed/modified)
console.log('\n=== Recent vulnerability diffs (last 10) ===');
const diffs = db.prepare(`
  SELECT d.id, d.from_date, d.to_date, ds.name AS dataset_name,
         d.added_count, d.removed_count, d.modified_count
  FROM diffs d
  JOIN datasets ds ON ds.id = d.dataset_id
  WHERE ds.category = 'vulnerability'
  ORDER BY d.to_date DESC
  LIMIT 15
`).all();
console.table(diffs);

// 4) For diffs with large removed_count, sample removed row_keys
const withRemoved = diffs.filter(d => d.removed_count > 0);
if (withRemoved.length > 0) {
  console.log('\n=== Sample of REMOVED vulns (first 2 diffs with removals) ===');
  for (const d of withRemoved.slice(0, 2)) {
    const items = db.prepare(`
      SELECT row_key, change_type FROM diff_items WHERE diff_id = ? AND change_type = 'removed' LIMIT 15
    `).all(d.id);
    console.log(`\nDiff ${d.id} ${d.dataset_name} ${d.from_date} -> ${d.to_date} (removed: ${d.removed_count})`);
    items.forEach(i => console.log(`  removed row_key: ${i.row_key}`));
  }
}

// 5) Modification patterns: which fields change most, and sample value changes
const withModified = diffs.filter(d => d.modified_count > 0);
if (withModified.length > 0) {
  console.log('\n=== MODIFICATION PATTERNS (fields that change most per diff) ===');
  for (const d of withModified) {
    const fieldCounts = getModifiedFieldCountsByDiff(d.id);
    console.log(`\n--- ${d.dataset_name}  ${d.from_date} -> ${d.to_date} (modified: ${d.modified_count}) ---`);
    if (fieldCounts.length === 0) {
      console.log('  (no changed_fields in DB for this diff)');
    } else {
      fieldCounts.slice(0, 25).forEach(({ field_name, change_count }) => {
        console.log(`  ${field_name}: ${change_count} rows`);
      });
      if (fieldCounts.length > 25) console.log(`  ... and ${fieldCounts.length - 25} more fields`);
    }
  }

  // Sample a few modified rows from the diff with the most modifications to see value patterns
  const topModified = withModified.slice(0, 2);
  console.log('\n=== Sample MODIFIED row value changes (what actually changed) ===');
  const SAMPLE_MODIFIED = 5;
  for (const d of topModified) {
    const { rows } = getDiffItemsPaginated(d.id, { changeType: 'modified', limit: SAMPLE_MODIFIED, offset: 0 });
    if (rows.length === 0) continue;
    console.log(`\n--- ${d.dataset_name}  ${d.from_date} -> ${d.to_date} (first ${rows.length} modified) ---`);
    for (const item of rows) {
      const fields = item.changed_fields ? (typeof item.changed_fields === 'string' ? JSON.parse(item.changed_fields) : item.changed_fields) : [];
      let changeSummary = '';
      if (item.field_changes && fields.length > 0) {
        let fc;
        try {
          fc = typeof item.field_changes === 'string' ? JSON.parse(item.field_changes) : item.field_changes;
        } catch {
          fc = {};
        }
        const parts = fields.slice(0, 8).map((f) => {
          const c = fc[f];
          if (!c) return null;
          const oldStr = c.old != null ? String(c.old).slice(0, 40) : 'null';
          const newStr = c.new != null ? String(c.new).slice(0, 40) : 'null';
          return `${f}: ${oldStr} → ${newStr}`;
        }).filter(Boolean);
        changeSummary = parts.join(' | ');
      }
      console.log(`  row_key: ${item.row_key}`);
      console.log(`  changed_fields: [${fields.join(', ')}]`);
      if (changeSummary) console.log(`  ${changeSummary}`);
      console.log('');
    }
  }
}

// 6) Today's date and latest snapshot date
const today = db.prepare("SELECT date('now') AS d").get();
const latest = db.prepare(`
  SELECT fetched_date FROM snapshots WHERE dataset_id IN (SELECT id FROM datasets WHERE category = 'vulnerability')
  ORDER BY fetched_date DESC LIMIT 1
`).get();
console.log('\n=== Dates ===');
console.log('Today (SQLite):', today?.d);
console.log('Latest vuln snapshot date:', latest?.fetched_date);

process.exit(0);
