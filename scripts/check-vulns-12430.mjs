#!/usr/bin/env node
/**
 * Check that a set of vulnerability IDs (e.g. from data/identifier.csv) exist
 * in the vulns-Digital One LFI (12430) dataset. Run from repo root:
 *   node scripts/check-vulns-12430.mjs
 *
 * Reads data/identifier.csv (one JSON line). Extracts vulnerability IDs from
 * identifiers.old/new (VulnerabilityId / vulnerabilityId). Queries the latest
 * snapshot for "vulns-Digital One LFI (12430)" and reports which IDs are
 * present or missing.
 */
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getDb } from '../src/db/index.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const IDENTIFIER_CSV = resolve(__dirname, '../data/identifier.csv');
const DATASET_NAME_12430 = 'vulns-Digital One LFI (12430)';

function extractVulnerabilityIdsFromIdentifierCsv() {
  let raw;
  try {
    raw = readFileSync(IDENTIFIER_CSV, 'utf-8').trim();
  } catch (e) {
    console.error('Could not read data/identifier.csv:', e.message);
    process.exit(1);
  }
  const ids = new Set();
  const lines = raw.split('\n').filter((l) => l.trim());
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      const identifiers = obj?.identifiers;
      if (!identifiers) continue;
      for (const side of ['old', 'new']) {
        const arr = identifiers[side];
        if (!Array.isArray(arr)) continue;
        for (const item of arr) {
          const mapping = item?.VulnerabilityIdentifierMapping;
          // Vulnerability record id (API row id) — this is what we store as row_key
          if (mapping?.vulnerabilityId) ids.add(mapping.vulnerabilityId);
          if (mapping?.VulnerabilityId) ids.add(mapping.VulnerabilityId);
        }
      }
    } catch (e) {
      console.warn('Skipping non-JSON line:', line.slice(0, 80) + '...');
    }
  }
  return Array.from(ids);
}

function main() {
  const db = getDb();

  const dataset = db.prepare(
    "SELECT id, name FROM datasets WHERE name = ?"
  ).get(DATASET_NAME_12430);
  if (!dataset) {
    console.error(`Dataset "${DATASET_NAME_12430}" not found.`);
    process.exit(1);
  }

  const latest = db.prepare(`
    SELECT id, fetched_date, row_count
    FROM snapshots
    WHERE dataset_id = ?
    ORDER BY fetched_date DESC
    LIMIT 1
  `).get(dataset.id);
  if (!latest) {
    console.error(`No snapshots found for ${DATASET_NAME_12430}.`);
    process.exit(1);
  }

  const idsToCheck = extractVulnerabilityIdsFromIdentifierCsv();
  if (idsToCheck.length === 0) {
    console.log('No vulnerability IDs found in data/identifier.csv.');
    process.exit(0);
  }

  console.log(`\n=== Vulnerabilities that should exist in 12430 ===`);
  console.log(`Dataset: ${DATASET_NAME_12430} (id=${dataset.id})`);
  console.log(`Snapshot: ${latest.fetched_date} (id=${latest.id}, row_count=${latest.row_count})`);
  console.log(`IDs to check (from data/identifier.csv): ${idsToCheck.length}\n`);

  const placeholders = idsToCheck.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT row_key
    FROM snapshot_rows
    WHERE snapshot_id = ? AND row_key IN (${placeholders})
  `).all(latest.id, ...idsToCheck);

  const found = new Set(rows.map((r) => r.row_key));
  const missing = idsToCheck.filter((id) => !found.has(id));

  console.log('Found in snapshot:');
  for (const id of idsToCheck) {
    const status = found.has(id) ? 'YES' : 'NO';
    console.log(`  ${status}  ${id}`);
  }

  if (missing.length > 0) {
    console.log(`\nMissing: ${missing.length} of ${idsToCheck.length}`);
    console.log('Missing IDs:', missing.join(', '));
    process.exitCode = 1;
  } else {
    console.log(`\nAll ${idsToCheck.length} ID(s) present in latest snapshot.`);
  }
}

main();
