#!/usr/bin/env node
/**
 * Seed script — generates realistic mock data across 7 days so the
 * dashboard has something visual to show (charts, diffs, drill-down).
 *
 * Usage:  node scripts/seed.mjs
 *
 * This will:
 *   1. Wipe the existing DB
 *   2. Create datasets for platform + vulnerability categories
 *   3. Generate 7 days of snapshots with gradual changes
 *   4. Compute diffs for each day pair
 *
 * Safe to re-run — it always starts fresh.
 */

import 'dotenv/config';
import { rmSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = resolve(__dirname, '..', 'data', 'daydiff.db');

// Nuke old DB
try { rmSync(DB_PATH); } catch {}
try { rmSync(DB_PATH + '-wal'); } catch {}
try { rmSync(DB_PATH + '-shm'); } catch {}

// Now import DB modules (they'll create a fresh DB)
const { getDb, ensureDataset, closeDb } = await import('../src/db/index.mjs');
const { insertSnapshot, insertDiff } = await import('../src/db/queries.mjs');

// ─── Config ─────────────────────────────────────────────────────

const DAYS = 7;
const START_DATE = new Date('2026-02-06');

function dateStr(d) {
  return d.toISOString().slice(0, 10);
}

const SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'];
const STATUSES = ['detected', 'in_progress', 'resolved', 'false_positive'];
const SCAN_TYPES = ['sast', 'kics', 'sca', 'dast'];
const SYSTEMS = ['checkmarx', 'snyk', 'sonarqube'];
const FILENAMES = [
  '/serverless.yml', '/src/auth/handler.ts', '/src/api/routes.ts',
  '/infrastructure/main.tf', '/Dockerfile', '/package.json',
  '/src/utils/crypto.ts', '/src/db/queries.ts', '/lib/http-client.ts',
  '/config/security.yml',
];
const VULN_NAMES = [
  'SQL Injection in query builder',
  'Cross-site scripting (XSS) in template',
  'Insecure TLS configuration',
  'Hardcoded credentials detected',
  'Missing authentication check',
  'Open redirect vulnerability',
  'Server-Side Request Forgery (SSRF)',
  'Insecure deserialization',
  'Path traversal in file handler',
  'Missing rate limiting',
  'Weak cryptographic algorithm',
  'IAM role is overly permissive',
  'Serverless function without DLQ',
  'Container running as root',
  'Outdated dependency with known CVE',
  'Missing CORS configuration',
  'Unencrypted data at rest',
  'Debug mode enabled in production',
  'Missing input validation',
  'Exposed health check endpoint',
];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

// ─── Platform data generators ───────────────────────────────────

function makeApp(id) {
  return {
    id: `app-${id}`,
    name: `service-${id}`,
    owner: pick(['team-alpha', 'team-beta', 'team-gamma', 'team-platform']),
    tier: pick(['tier-1', 'tier-2', 'tier-3']),
    language: pick(['typescript', 'python', 'go', 'java']),
    status: pick(['active', 'active', 'active', 'deprecated']),
    repoCount: Math.floor(Math.random() * 8) + 1,
    componentCount: Math.floor(Math.random() * 15) + 2,
    createdAt: '2024-03-15T10:00:00Z',
    updatedAt: new Date().toISOString(),
  };
}

function makeComponent(id) {
  return {
    id: `comp-${id}`,
    name: `component-${id}`,
    type: pick(['service', 'library', 'lambda', 'api-gateway', 'database', 'queue']),
    language: pick(['typescript', 'python', 'go', 'java', 'terraform']),
    owner: pick(['team-alpha', 'team-beta', 'team-gamma']),
    lifecycle: pick(['production', 'production', 'staging', 'development', 'deprecated']),
    system: pick(['core-platform', 'payments', 'user-management', 'notifications']),
  };
}

function makeRepo(id) {
  return {
    id: `repo-${id}`,
    name: `repo-${['api', 'web', 'infra', 'lib', 'worker', 'gateway'][id % 6]}-${id}`,
    url: `https://github.com/org/repo-${id}`,
    defaultBranch: 'main',
    language: pick(['TypeScript', 'Python', 'Go', 'Java', 'HCL']),
    isArchived: Math.random() < 0.05,
    openPRs: Math.floor(Math.random() * 10),
    lastCommitDate: new Date().toISOString(),
  };
}

// ─── Vulnerability data generator ───────────────────────────────

function makeVuln(id, vulnerableId) {
  const sev = pick(SEVERITIES);
  return {
    id: uuid(),
    name: pick(VULN_NAMES),
    description: `Detailed description for vulnerability ${id}`,
    originatingSystem: pick(SYSTEMS),
    originatingSystemId: uuid(),
    scanType: pick(SCAN_TYPES),
    severity: sev,
    status: pick(STATUSES),
    location: {
      line: Math.floor(Math.random() * 500) + 1,
      fileName: pick(FILENAMES),
      queryName: pick(VULN_NAMES),
    },
    openDate: '2025-06-15T10:00:00Z',
    closeDate: null,
    vulnerableId,
    vulnerableType: 'repo',
    dueDate: '2025-09-15T10:00:00Z',
    atRiskDate: '2025-08-15T10:00:00Z',
  };
}

// ─── Mutation helpers (simulate daily changes) ──────────────────

function mutateRow(row, type) {
  const clone = JSON.parse(JSON.stringify(row));

  if (type === 'platform-app') {
    if (Math.random() < 0.3) clone.repoCount += Math.random() < 0.5 ? 1 : -1;
    if (Math.random() < 0.2) clone.componentCount += Math.floor(Math.random() * 3) - 1;
    if (Math.random() < 0.05) clone.status = clone.status === 'active' ? 'deprecated' : 'active';
    clone.updatedAt = new Date().toISOString();
  }

  if (type === 'platform-component') {
    if (Math.random() < 0.1) clone.lifecycle = pick(['production', 'staging', 'deprecated']);
    if (Math.random() < 0.05) clone.owner = pick(['team-alpha', 'team-beta', 'team-gamma']);
  }

  if (type === 'platform-repo') {
    clone.openPRs = Math.max(0, clone.openPRs + Math.floor(Math.random() * 5) - 2);
    clone.lastCommitDate = new Date().toISOString();
    if (Math.random() < 0.02) clone.isArchived = !clone.isArchived;
  }

  if (type === 'vuln') {
    // Severity changes
    if (Math.random() < 0.08) clone.severity = pick(SEVERITIES);
    // Status transitions
    if (Math.random() < 0.12) clone.status = pick(STATUSES);
    // Close some vulns
    if (clone.status === 'resolved' && !clone.closeDate) {
      clone.closeDate = new Date().toISOString();
    }
  }

  return clone;
}

// ─── Main seed logic ────────────────────────────────────────────

console.log('\n=== Seeding DayDiff with mock data ===\n');

// Create datasets
const appDs = ensureDataset('applications', '/applications', 'id', 'platform');
const compDs = ensureDataset('components', '/components', 'id', 'platform');
const repoDs = ensureDataset('repositories', '/repositories', 'id', 'platform');
const vulnDs1 = ensureDataset('vulns-app-one', '/vulnerabilities', 'id', 'vulnerability');
const vulnDs2 = ensureDataset('vulns-app-two', '/vulnerabilities', 'id', 'vulnerability');

const dsConfigs = [
  { ds: appDs, count: 20, maker: (i) => makeApp(i), type: 'platform-app' },
  { ds: compDs, count: 35, maker: (i) => makeComponent(i), type: 'platform-component' },
  { ds: repoDs, count: 45, maker: (i) => makeRepo(i), type: 'platform-repo' },
  { ds: vulnDs1, count: 250, maker: (i) => makeVuln(i, 'asset-aaa'), type: 'vuln' },
  { ds: vulnDs2, count: 180, maker: (i) => makeVuln(i, 'asset-bbb'), type: 'vuln' },
];

// Generate day-0 baseline rows for each dataset
const baselineRows = {};
for (const cfg of dsConfigs) {
  baselineRows[cfg.ds.id] = [];
  for (let i = 0; i < cfg.count; i++) {
    const data = cfg.maker(i);
    baselineRows[cfg.ds.id].push({ key: data.id, data });
  }
}

// For each day, evolve the data and store snapshot + diff
for (let day = 0; day < DAYS; day++) {
  const d = new Date(START_DATE);
  d.setDate(d.getDate() + day);
  const date = dateStr(d);

  console.log(`[seed] Day ${day + 1}/${DAYS}: ${date}`);

  for (const cfg of dsConfigs) {
    let rows = baselineRows[cfg.ds.id];

    if (day > 0) {
      const prevRows = [...rows];
      const newRows = [];

      for (const row of prevRows) {
        // Small chance of removal
        if (Math.random() < 0.015) continue; // removed
        newRows.push({ key: row.key, data: mutateRow(row.data, cfg.type) });
      }

      // Small chance of additions
      const addCount = Math.floor(Math.random() * (cfg.type === 'vuln' ? 12 : 3));
      for (let a = 0; a < addCount; a++) {
        const newId = cfg.count + day * 20 + a;
        const data = cfg.maker(newId);
        newRows.push({ key: data.id, data });
      }

      rows = newRows;
      baselineRows[cfg.ds.id] = rows;
    }

    // Store snapshot
    insertSnapshot(cfg.ds.id, date, rows);
  }
}

// Now compute diffs for each consecutive day pair
console.log('\n[seed] Computing diffs...\n');

// Import diff engine internals
const {
  getSnapshotRows,
  getPreviousSnapshot,
  getLatestSnapshot,
} = await import('../src/db/queries.mjs');

// deepEqual, findChangedFields, buildFieldChanges, computeDiff — inline minimal versions
function deepEqual(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const k of keysA) {
    if (!deepEqual(a[k], b[k])) return false;
  }
  return true;
}

function findChangedFields(oldRow, newRow) {
  const allKeys = new Set([...Object.keys(oldRow), ...Object.keys(newRow)]);
  const changed = [];
  for (const k of allKeys) {
    if (!deepEqual(oldRow[k], newRow[k])) changed.push(k);
  }
  return changed;
}

function computeDiff(oldMap, newMap) {
  const items = [];
  let added = 0, removed = 0, modified = 0, unchanged = 0;

  for (const [key, oldData] of oldMap) {
    if (!newMap.has(key)) {
      removed++;
      items.push({ rowKey: key, changeType: 'removed', rowData: oldData, fieldChanges: null, changedFields: null });
    } else {
      const newData = newMap.get(key);
      const cf = findChangedFields(oldData, newData);
      if (cf.length > 0) {
        modified++;
        const fc = {};
        for (const f of cf) fc[f] = { old: oldData[f] ?? null, new: newData[f] ?? null };
        items.push({ rowKey: key, changeType: 'modified', rowData: newData, fieldChanges: fc, changedFields: cf });
      } else {
        unchanged++;
      }
    }
  }

  for (const [key, newData] of newMap) {
    if (!oldMap.has(key)) {
      added++;
      items.push({ rowKey: key, changeType: 'added', rowData: newData, fieldChanges: null, changedFields: null });
    }
  }

  return { summary: { added, removed, modified, unchanged }, items };
}

// Walk each dataset through the days
const db = getDb();
const allSnapshots = db.prepare(`
  SELECT s.id, s.dataset_id, s.fetched_date, s.row_count
  FROM snapshots s ORDER BY s.dataset_id, s.fetched_date
`).all();

const byDataset = {};
for (const s of allSnapshots) {
  if (!byDataset[s.dataset_id]) byDataset[s.dataset_id] = [];
  byDataset[s.dataset_id].push(s);
}

let totalDiffs = 0;
for (const [dsId, snaps] of Object.entries(byDataset)) {
  for (let i = 1; i < snaps.length; i++) {
    const prev = snaps[i - 1];
    const curr = snaps[i];
    const oldRows = getSnapshotRows(prev.id);
    const newRows = getSnapshotRows(curr.id);
    const { summary, items } = computeDiff(oldRows, newRows);

    insertDiff(parseInt(dsId), prev.fetched_date, curr.fetched_date, summary, items);

    const dsName = db.prepare('SELECT name FROM datasets WHERE id = ?').get(parseInt(dsId)).name;
    console.log(
      `[seed] ${dsName} ${prev.fetched_date} → ${curr.fetched_date}: ` +
      `+${summary.added} -${summary.removed} ~${summary.modified} =${summary.unchanged}`
    );
    totalDiffs++;
  }
}

console.log(`\n=== Seed complete: ${totalDiffs} diffs across ${DAYS} days ===`);
console.log('Restart the dashboard and refresh the browser.\n');

closeDb();
