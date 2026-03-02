#!/usr/bin/env node
/**
 * Analyze the "resolved" and "missing" groups from the expected-vulns check:
 * - Resolved: breakdown by originatingSystem and scanType (e.g. are they Rapid7?)
 * - Missing: pattern by ID numeric range (e.g. higher VIT numbers?)
 *
 * Run after check-expected-vulns.mjs with same CSV:
 *   node scripts/analyze-expected-vulns.mjs data/FIS_ONLY_TRIMMED2.csv
 */
import { readFileSync, writeFileSync } from 'fs';
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

function parseNumbersArchive(zipPath) {
  const tmpDir = mkdtempSync(join(tmpdir(), 'daydiff-numbers-'));
  try {
    execSync(`unzip -o -q "${zipPath}" -d "${tmpDir}"`, { stdio: 'pipe' });
    const ids = new Map();
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
  const raw = readFileSync(filePath, 'utf-8');
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
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

function extractNumeric(id) {
  const m = /(?:VIT|AVIT)(\d+)/.exec(id);
  return m ? parseInt(m[1], 10) : null;
}

function stats(arr) {
  if (arr.length === 0) return { min: null, max: null, median: null, count: 0 };
  const sorted = [...arr].sort((a, b) => a - b);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return { min, max, median, count: arr.length };
}

function main() {
  const csvPath = process.argv[2] ? resolve(process.cwd(), process.argv[2]) : DEFAULT_CSV;
  let ids;
  const buf = readFileSync(csvPath);
  if (buf.length >= 2 && buf[0] === 0x50 && buf[1] === 0x4b) {
    ids = parseNumbersArchive(csvPath);
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
    FROM snapshots WHERE dataset_id = ? ORDER BY fetched_date DESC LIMIT 1
  `).get(dataset.id);
  if (!snapshot) {
    console.error(`No snapshot for ${DATASET_NAME_12430}.`);
    process.exit(1);
  }

  const idSet = new Set(ids.map((id) => id.trim()).filter(Boolean));
  const resultsById = new Map();
  let foundCount = 0;

  const stmt = db.prepare(`
    SELECT row_key, row_data
    FROM snapshot_rows WHERE snapshot_id = ?
  `);
  for (const row of stmt.iterate(snapshot.id)) {
    if (foundCount === idSet.size) break;
    let status = null;
    let data = null;
    try {
      data = typeof row.row_data === 'string' ? JSON.parse(row.row_data) : row.row_data;
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
        resultsById.set(id, { status, row_key: row.row_key, data });
        foundCount++;
      }
    }
  }

  const resolved = [];
  const missing = [];
  const detected = [];
  for (const id of ids) {
    const idTrim = id.trim();
    if (!idTrim) continue;
    const hit = resultsById.get(idTrim);
    if (!hit) {
      missing.push(idTrim);
    } else if (hit.status === 'resolved') {
      resolved.push({ id: idTrim, row_key: hit.row_key, data: hit.data });
    } else {
      detected.push(idTrim);
    }
  }

  console.log('\n=== Analysis: Resolved (expected detected) and Missing ===\n');
  console.log(`Snapshot: ${snapshot.fetched_date} | CSV: ${ids.length} IDs`);
  console.log(`Detected (OK): ${detected.length} | Resolved (mislabeled): ${resolved.length} | Missing: ${missing.length}\n`);

  // Write CSV of resolved IDs only (optional: same dir as input, basename-resolved.csv)
  const resolvedIds = resolved.map((r) => r.id);
  if (resolvedIds.length > 0) {
    const outPath = csvPath.replace(/\.csv$/i, '-resolved.csv');
    writeFileSync(outPath, 'number\n' + resolvedIds.join('\n') + '\n', 'utf-8');
    console.log(`Wrote ${resolvedIds.length} resolved IDs to ${outPath}\n`);
  }

  // Write CSV of missing IDs (not in snapshot at all)
  if (missing.length > 0) {
    const missingPath = csvPath.replace(/\.csv$/i, '-missing.csv');
    writeFileSync(missingPath, 'number\n' + missing.join('\n') + '\n', 'utf-8');
    console.log(`Wrote ${missing.length} missing IDs to ${missingPath}\n`);
  }

  // --- Resolved: originatingSystem and scanType ---
  const byOrigin = new Map();
  const byScanType = new Map();
  for (const { data } of resolved) {
    if (!data) continue;
    const orig = data.originatingSystem ?? '(null)';
    byOrigin.set(orig, (byOrigin.get(orig) ?? 0) + 1);
    const scan = data.scanType ?? '(null)';
    byScanType.set(scan, (byScanType.get(scan) ?? 0) + 1);
  }

  console.log('--- RESOLVED (expected detected): source/originating pattern ---');
  console.log('By originatingSystem:');
  const origins = [...byOrigin.entries()].sort((a, b) => b[1] - a[1]);
  for (const [k, v] of origins) {
    console.log(`  ${String(v).padStart(6)}  ${k}`);
  }
  console.log('\nBy scanType:');
  const scans = [...byScanType.entries()].sort((a, b) => b[1] - a[1]);
  for (const [k, v] of scans) {
    console.log(`  ${String(v).padStart(6)}  ${k}`);
  }

  // --- Dates: resolved vs detected ---
  const dateFields = ['openDate', 'closeDate', 'createdAt', 'updatedAt'];
  function parseDate(v) {
    if (v == null || v === '') return null;
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }
  function dateStats(arr) {
    const parsed = arr.filter((d) => d != null);
    if (parsed.length === 0) return { min: null, max: null, median: null, count: 0 };
    const sorted = [...parsed].sort((a, b) => a.getTime() - b.getTime());
    const min = sorted[0].toISOString().slice(0, 10);
    const max = sorted[sorted.length - 1].toISOString().slice(0, 10);
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 ? sorted[mid].toISOString().slice(0, 10) : sorted[mid - 1].toISOString().slice(0, 10);
    return { min, max, median, count: parsed.length };
  }
  console.log('\n--- Dates: RESOLVED (expected detected) vs DETECTED (OK) ---');
  for (const field of dateFields) {
    const resolvedDates = resolved.map((r) => r.data && parseDate(r.data[field])).filter(Boolean);
    const detectedData = [];
    for (const id of detected) {
      const hit = resultsById.get(id);
      if (hit?.data && hit.data[field]) detectedData.push(parseDate(hit.data[field]));
    }
    const rStats = dateStats(resolvedDates);
    const dStats = dateStats(detectedData);
    console.log(`  ${field}:`);
    console.log(`    Resolved:  min ${rStats.min ?? '-'} | max ${rStats.max ?? '-'} | median ${rStats.median ?? '-'} (n=${rStats.count})`);
    console.log(`    Detected: min ${dStats.min ?? '-'} | max ${dStats.max ?? '-'} | median ${dStats.median ?? '-'} (n=${dStats.count})`);
  }

  // --- Missing: numeric range pattern ---
  const missingNums = missing.map(extractNumeric).filter((n) => n != null);
  const detectedNums = detected.map(extractNumeric).filter((n) => n != null);
  const resolvedNums = resolved.map((r) => extractNumeric(r.id)).filter((n) => n != null);

  const sMissing = stats(missingNums);
  const sDetected = stats(detectedNums);
  const sResolved = stats(resolvedNums);

  console.log('\n--- MISSING: numeric ID range pattern ---');
  console.log('(VIT/AVIT numeric part only; IDs not present in latest snapshot.)');
  console.log('Missing  numeric range: min', sMissing.min, '| max', sMissing.max, '| median', sMissing.median);
  console.log('Detected numeric range: min', sDetected.min, '| max', sDetected.max, '| median', sDetected.median);
  console.log('Resolved numeric range: min', sResolved.min, '| max', sResolved.max, '| median', sResolved.median);

  function bucket(num) {
    if (num < 1e6) return '< 1M';
    if (num < 10e6) return '1M-10M';
    if (num < 100e6) return '10M-100M';
    return '100M+';
  }
  const missingBuckets = new Map();
  const detectedBuckets = new Map();
  for (const n of missingNums) {
    const b = bucket(n);
    missingBuckets.set(b, (missingBuckets.get(b) ?? 0) + 1);
  }
  for (const n of detectedNums) {
    const b = bucket(n);
    detectedBuckets.set(b, (detectedBuckets.get(b) ?? 0) + 1);
  }
  console.log('\nMissing by numeric magnitude:');
  for (const b of ['< 1M', '1M-10M', '10M-100M', '100M+']) {
    const c = missingBuckets.get(b) ?? 0;
    if (c > 0) console.log(`  ${b}: ${c}`);
  }
  console.log('Detected by numeric magnitude:');
  for (const b of ['< 1M', '1M-10M', '10M-100M', '100M+']) {
    const c = detectedBuckets.get(b) ?? 0;
    if (c > 0) console.log(`  ${b}: ${c}`);
  }

  const missingSorted = [...missingNums].sort((a, b) => a - b);
  const sampleLow = missingSorted.slice(0, 5);
  const sampleHigh = missingSorted.slice(-5);
  console.log('\nSample missing IDs (lowest numeric):', sampleLow.map((n) => `VIT${n}`).join(', '));
  console.log('Sample missing IDs (highest numeric):', sampleHigh.map((n) => `VIT${n}`).join(', '));
  console.log('');
}

main();
