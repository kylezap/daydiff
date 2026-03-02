#!/usr/bin/env node
/**
 * Check expected vulnerabilities (AVIT/VIT IDs) in the 12430 dataset.
 * Reads a one-column CSV of vulnerability IDs you expect to be "detected".
 * Reports which are missing, which are present, and their status (detected vs resolved).
 *
 * Usage (from repo root):
 *   node scripts/check-expected-vulns.mjs [path-to.csv]
 *
 * Default CSV: data/expected-vulns.csv
 * CSV format: one column (header optional), one ID per row. Column header may be "id", "number", "avit", "vit", etc.
 * If the file is actually an Apple Numbers archive (.numbers renamed to .csv), IDs are extracted from the archive.
 * IDs can be:
 *   - Vulnerability record UUID (row_key in DB)
 *   - Identifier UUID (searched in row_data)
 *   - CVE id (e.g. CVE-2025-31133) if present in row_data
 */
import { readFileSync } from 'fs';
import { readdirSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { mkdtempSync, rmSync } from 'fs';
import { execSync } from 'child_process';
import { getDb } from '../src/db/index.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CSV = resolve(__dirname, '../data/expected-vulns.csv');
const DATASET_NAME_12430 = 'vulns-Digital One LFI (12430)';

const VIT_AVIT_RE = /(?:VIT|AVIT)\d+/g;

/**
 * Extract VIT/AVIT IDs from an Apple Numbers archive (zip).
 * @param {string} zipPath - path to .numbers or zip file
 * @returns {string[]} unique IDs in order of first occurrence
 */
function parseNumbersArchive(zipPath) {
  const tmpDir = mkdtempSync(join(tmpdir(), 'daydiff-numbers-'));
  try {
    execSync(`unzip -o -q "${zipPath}" -d "${tmpDir}"`, { stdio: 'pipe' });
    const ids = new Map(); // id -> order
    let order = 0;
    const tablesDir = join(tmpDir, 'Index', 'Tables');
    try {
      const files = readdirSync(tablesDir).filter((f) => f.startsWith('DataList') && f.endsWith('.iwa'));
      for (const f of files) {
        const buf = readFileSync(join(tablesDir, f));
        const str = buf.toString('utf-8', 0, buf.length);
        let m;
        while ((m = VIT_AVIT_RE.exec(str)) !== null) {
          if (!ids.has(m[0])) ids.set(m[0], order++);
        }
      }
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    return Array.from(ids.keys()).sort((a, b) => (ids.get(a) - ids.get(b)));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

function parseOneColumnCsv(filePath) {
  let raw;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch (e) {
    if (e.code === 'ENOENT') {
      console.error(`File not found: ${filePath}`);
      console.error('Create a CSV with one column of vulnerability IDs (AVIT/VIT), one per row.');
      process.exit(1);
    }
    throw e;
  }
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return [];
  const values = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const cell = line.includes(',') ? line.split(',')[0].replace(/^"|"$/g, '').trim() : line;
    if (!cell) continue;
    const lower = cell.toLowerCase();
    if (i === 0 && (lower === 'id' || lower === 'number' || lower === 'avit' || lower === 'vit' || lower === 'vulnerability_id' || lower === 'vulnerability id')) continue;
    values.push(cell);
  }
  return values;
}

function main() {
  const csvPath = process.argv[2] ? resolve(process.cwd(), process.argv[2]) : DEFAULT_CSV;
  let ids;
  const buf = readFileSync(csvPath);
  if (buf.length >= 2 && buf[0] === 0x50 && buf[1] === 0x4b) {
    ids = parseNumbersArchive(csvPath);
    if (ids.length === 0) {
      console.error('No VIT/AVIT IDs found in Numbers archive.');
      process.exit(1);
    }
  } else {
    ids = parseOneColumnCsv(csvPath);
  }
  if (ids.length === 0) {
    console.error('No IDs found in CSV.');
    process.exit(1);
  }

  const db = getDb();

  const dataset = db.prepare('SELECT id, name FROM datasets WHERE name = ?').get(DATASET_NAME_12430);
  if (!dataset) {
    console.error(`Dataset "${DATASET_NAME_12430}" not found.`);
    process.exit(1);
  }

  const snapshot = db.prepare(`
    SELECT id, fetched_date, row_count
    FROM snapshots
    WHERE dataset_id = ?
    ORDER BY fetched_date DESC
    LIMIT 1
  `).get(dataset.id);
  if (!snapshot) {
    console.error(`No snapshot for ${DATASET_NAME_12430}.`);
    process.exit(1);
  }

  console.log('\n=== Expected vulnerabilities in 12430 (detected vs resolved) ===');
  console.log(`Dataset: ${DATASET_NAME_12430}`);
  console.log(`Snapshot: ${snapshot.fetched_date} (${snapshot.row_count} rows)`);
  console.log(`CSV: ${csvPath} (${ids.length} ID(s))`);
  console.log('');

  const idSet = new Set(ids.map((id) => id.trim()).filter(Boolean));
  const resultsById = new Map(); // id -> { status, row_key }
  let foundCount = 0;

  // Single streaming pass: for each row get VIT/AVIT ids from row_data via regex, record if in our list
  const stmt = db.prepare(`
    SELECT row_key, row_data
    FROM snapshot_rows
    WHERE snapshot_id = ?
  `);
  for (const row of stmt.iterate(snapshot.id)) {
    if (foundCount === idSet.size) break;
    let status = null;
    try {
      const data = typeof row.row_data === 'string' ? JSON.parse(row.row_data) : row.row_data;
      status = data?.status ?? null;
    } catch {
      // skip
    }
    const raw = typeof row.row_data === 'string' ? row.row_data : JSON.stringify(row.row_data);
    let m;
    VIT_AVIT_RE.lastIndex = 0;
    while ((m = VIT_AVIT_RE.exec(raw)) !== null) {
      const id = m[0];
      if (idSet.has(id) && !resultsById.has(id)) {
        resultsById.set(id, { status, row_key: row.row_key });
        foundCount++;
      }
    }
  }

  const results = [];
  for (const id of ids) {
    const idTrim = id.trim();
    if (!idTrim) continue;
    const hit = resultsById.get(idTrim);
    const found = !!hit;
    const statusLabel = hit?.status ?? (found ? '(no status)' : '');
    const mislabeled = found && hit?.status === 'resolved';
    results.push({
      id: idTrim,
      found,
      status: statusLabel,
      row_key: hit?.row_key ?? null,
      mislabeled,
    });
  }

  const col = (s, w) => String(s).padEnd(w);
  const header = `${col('ID', 40)} ${col('Found', 6)} ${col('Status', 12)} ${col('Note', 30)}`;
  console.log(header);
  console.log('-'.repeat(header.length));

  for (const r of results) {
    const note = !r.found ? 'MISSING' : r.mislabeled ? 'Expected detected, actual resolved' : (r.status === 'detected' ? 'OK' : '');
    console.log(`${col(r.id.slice(0, 40), 40)} ${col(r.found ? 'YES' : 'NO', 6)} ${col(r.status || '-', 12)} ${col(note, 30)}`);
  }

  const missing = results.filter((r) => !r.found).length;
  const resolved = results.filter((r) => r.mislabeled).length;
  const ok = results.filter((r) => r.found && r.status === 'detected').length;

  console.log('');
  console.log(`Summary: ${ok} detected (OK), ${resolved} resolved (expected detected), ${missing} missing`);
  if (missing > 0 || resolved > 0) process.exitCode = 1;
}

main();
