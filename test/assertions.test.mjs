import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestDb, teardownTestDb } from './helpers.mjs';
import { ensureDataset } from '../src/db/index.mjs';
import { insertSnapshot, insertDiff } from '../src/db/queries.mjs';
import {
  getFlappingRows,
  getFieldStability,
  getSourceSegments,
  checkReferentialIntegrity,
  insertAssertionResult,
  getAssertionResults,
  getAssertionHistory,
  clearAssertionResults,
} from '../src/analysis/queries.mjs';
import { runAssertions } from '../src/analysis/assertions.mjs';

// ─── Analysis Queries ────────────────────────────────────────────

describe('analysis/queries', () => {
  let dataset;

  beforeEach(() => {
    const ctx = setupTestDb();
    dataset = ctx.dataset;
  });

  afterEach(() => {
    teardownTestDb();
  });

  // ── Flapping Detection ────────────────────────────────────────

  describe('getFlappingRows', () => {
    it('detects rows that flip between added and removed', () => {
      // Use dates close to "now" so they fall within the rolling window
      const diffId1 = insertDiff(dataset.id, '2026-02-10', '2026-02-11', {
        added: 1, removed: 0, modified: 0, unchanged: 0,
      }, [
        { rowKey: 'flappy-1', changeType: 'added', rowData: { id: 'flappy-1' } },
      ]);

      const diffId2 = insertDiff(dataset.id, '2026-02-11', '2026-02-12', {
        added: 0, removed: 1, modified: 0, unchanged: 0,
      }, [
        { rowKey: 'flappy-1', changeType: 'removed', rowData: { id: 'flappy-1' } },
      ]);

      const rows = getFlappingRows(dataset.id, 30);
      assert.ok(rows.length >= 1, 'Should detect at least one flapping row');
      assert.equal(rows[0].row_key, 'flappy-1');
    });

    it('returns empty when no flapping exists', () => {
      insertDiff(dataset.id, '2026-02-10', '2026-02-11', {
        added: 1, removed: 0, modified: 0, unchanged: 0,
      }, [
        { rowKey: 'stable-1', changeType: 'added', rowData: { id: 'stable-1' } },
      ]);

      const rows = getFlappingRows(dataset.id, 30);
      assert.equal(rows.length, 0);
    });
  });

  // ── Field Stability ───────────────────────────────────────────

  describe('getFieldStability', () => {
    it('counts field-level changes from modified rows', () => {
      insertDiff(dataset.id, '2026-02-10', '2026-02-11', {
        added: 0, removed: 0, modified: 2, unchanged: 0,
      }, [
        {
          rowKey: 'row-1',
          changeType: 'modified',
          rowData: { id: 'row-1', status: 'open', severity: 'high' },
          fieldChanges: { status: { old: 'new', new: 'open' } },
          changedFields: ['status'],
        },
        {
          rowKey: 'row-2',
          changeType: 'modified',
          rowData: { id: 'row-2', status: 'closed', severity: 'low' },
          fieldChanges: { status: { old: 'open', new: 'closed' }, severity: { old: 'high', new: 'low' } },
          changedFields: ['status', 'severity'],
        },
      ]);

      const stability = getFieldStability(dataset.id, 30);
      assert.ok(stability.length >= 1, 'Should return field stability data');

      const statusField = stability.find(f => f.field_name === 'status');
      assert.ok(statusField, 'Should include status field');
      assert.equal(statusField.change_count, 2);

      const severityField = stability.find(f => f.field_name === 'severity');
      assert.ok(severityField, 'Should include severity field');
      assert.equal(severityField.change_count, 1);
    });

    it('returns empty when no modified rows exist', () => {
      insertDiff(dataset.id, '2026-02-10', '2026-02-11', {
        added: 1, removed: 0, modified: 0, unchanged: 0,
      }, [
        { rowKey: 'row-1', changeType: 'added', rowData: { id: 'row-1' } },
      ]);

      const stability = getFieldStability(dataset.id, 30);
      assert.equal(stability.length, 0);
    });
  });

  // ── Source Segments ───────────────────────────────────────────

  describe('getSourceSegments', () => {
    it('groups changes by originating system and scan type', () => {
      insertDiff(dataset.id, '2026-02-10', '2026-02-11', {
        added: 2, removed: 0, modified: 0, unchanged: 0,
      }, [
        {
          rowKey: 'vuln-1',
          changeType: 'added',
          rowData: { id: 'vuln-1', originatingSystem: 'Checkmarx', scanType: 'SAST' },
        },
        {
          rowKey: 'vuln-2',
          changeType: 'added',
          rowData: { id: 'vuln-2', originatingSystem: 'Checkmarx', scanType: 'SAST' },
        },
      ]);

      const segments = getSourceSegments(dataset.id, '2026-02-11');
      assert.ok(segments.length >= 1, 'Should return source segments');
      assert.equal(segments[0].source, 'Checkmarx');
      assert.equal(segments[0].scan_type, 'SAST');
      assert.equal(segments[0].cnt, 2);
    });
  });

  // ── Referential Integrity ─────────────────────────────────────

  describe('checkReferentialIntegrity', () => {
    it('finds orphaned vulnerableId references', () => {
      // Create a platform dataset
      const platformDs = ensureDataset('test-apps', '/apps', 'id', 'platform');

      // Insert platform snapshot with known IDs
      insertSnapshot(platformDs.id, '2025-01-02', [
        { key: 'app-1', data: { id: 'app-1', name: 'App One' } },
        { key: 'app-2', data: { id: 'app-2', name: 'App Two' } },
      ]);

      // Insert vuln snapshot referencing app-1 (valid) and app-999 (orphan)
      insertSnapshot(dataset.id, '2025-01-02', [
        { key: 'vuln-1', data: { id: 'vuln-1', vulnerableId: 'app-1' } },
        { key: 'vuln-2', data: { id: 'vuln-2', vulnerableId: 'app-999' } },
        { key: 'vuln-3', data: { id: 'vuln-3', vulnerableId: 'app-999' } },
      ]);

      const orphans = checkReferentialIntegrity('2025-01-02');
      assert.ok(orphans.length >= 1, 'Should find orphaned references');

      const orphan = orphans.find(o => o.vulnerable_id === 'app-999');
      assert.ok(orphan, 'app-999 should be flagged as orphaned');
      assert.equal(orphan.vuln_count, 2);
    });

    it('returns empty when all references are valid', () => {
      const platformDs = ensureDataset('test-apps-valid', '/apps', 'id', 'platform');

      insertSnapshot(platformDs.id, '2025-01-02', [
        { key: 'app-1', data: { id: 'app-1' } },
      ]);

      insertSnapshot(dataset.id, '2025-01-02', [
        { key: 'vuln-1', data: { id: 'vuln-1', vulnerableId: 'app-1' } },
      ]);

      const orphans = checkReferentialIntegrity('2025-01-02');
      assert.equal(orphans.length, 0);
    });
  });

  // ── Assertion CRUD ────────────────────────────────────────────

  describe('Assertion CRUD', () => {
    it('stores and retrieves assertion results', () => {
      insertAssertionResult('test-check', dataset.id, '2025-01-02', true, 'All good');
      insertAssertionResult('test-check-2', dataset.id, '2025-01-02', false, 'Something wrong', { detail: 'value' });

      const results = getAssertionResults('2025-01-02');
      assert.equal(results.length, 2);

      const passing = results.find(r => r.assertion_id === 'test-check');
      assert.equal(passing.passed, 1);
      assert.equal(passing.message, 'All good');

      const failing = results.find(r => r.assertion_id === 'test-check-2');
      assert.equal(failing.passed, 0);
      assert.equal(failing.message, 'Something wrong');
    });

    it('returns history for a specific assertion', () => {
      insertAssertionResult('trend-check', dataset.id, '2026-02-10', true, 'OK');
      insertAssertionResult('trend-check', dataset.id, '2026-02-11', false, 'Failed');
      insertAssertionResult('trend-check', dataset.id, '2026-02-12', true, 'OK again');

      const history = getAssertionHistory('trend-check', 30);
      assert.equal(history.length, 3);
    });

    it('clears results for a date', () => {
      insertAssertionResult('clear-test', dataset.id, '2025-01-02', true, 'OK');
      clearAssertionResults('2025-01-02');

      const results = getAssertionResults('2025-01-02');
      assert.equal(results.length, 0);
    });
  });
});

// ─── Assertion Engine ────────────────────────────────────────────

describe('analysis/assertions engine', () => {
  let dataset;

  beforeEach(() => {
    const ctx = setupTestDb();
    dataset = ctx.dataset;
  });

  afterEach(() => {
    teardownTestDb();
  });

  it('population-drop passes when count is stable', () => {
    insertSnapshot(dataset.id, '2025-01-01', [
      { key: 'v1', data: { id: 'v1' } },
      { key: 'v2', data: { id: 'v2' } },
    ]);
    insertSnapshot(dataset.id, '2025-01-02', [
      { key: 'v1', data: { id: 'v1' } },
      { key: 'v2', data: { id: 'v2' } },
    ]);

    const config = [{
      id: 'pop-test',
      name: 'Population test',
      check: 'population-drop',
      threshold: 0.10,
      category: 'vulnerability',
    }];

    const results = runAssertions('2025-01-02', config);
    assert.equal(results.length, 1);
    assert.equal(results[0].passed, true);
  });

  it('population-drop fails when count drops significantly', () => {
    insertSnapshot(dataset.id, '2025-01-01', [
      { key: 'v1', data: { id: 'v1' } },
      { key: 'v2', data: { id: 'v2' } },
      { key: 'v3', data: { id: 'v3' } },
      { key: 'v4', data: { id: 'v4' } },
      { key: 'v5', data: { id: 'v5' } },
      { key: 'v6', data: { id: 'v6' } },
      { key: 'v7', data: { id: 'v7' } },
      { key: 'v8', data: { id: 'v8' } },
      { key: 'v9', data: { id: 'v9' } },
      { key: 'v10', data: { id: 'v10' } },
    ]);
    insertSnapshot(dataset.id, '2025-01-02', [
      { key: 'v1', data: { id: 'v1' } },
      { key: 'v2', data: { id: 'v2' } },
    ]);

    const config = [{
      id: 'pop-test',
      name: 'Population test',
      check: 'population-drop',
      threshold: 0.10,
      category: 'vulnerability',
    }];

    const results = runAssertions('2025-01-02', config);
    assert.equal(results.length, 1);
    assert.equal(results[0].passed, false);
    assert.ok(results[0].message.includes('Population drop'));
  });

  it('fetch-complete passes when row_count matches api_total', () => {
    insertSnapshot(dataset.id, '2025-01-02', [
      { key: 'v1', data: { id: 'v1' } },
      { key: 'v2', data: { id: 'v2' } },
    ], { apiTotal: 2 });

    const config = [{
      id: 'fetch-test',
      name: 'Fetch test',
      check: 'fetch-complete',
    }];

    const results = runAssertions('2025-01-02', config);
    assert.equal(results.length, 1);
    assert.equal(results[0].passed, true);
  });

  it('fetch-complete fails when row_count does not match api_total', () => {
    insertSnapshot(dataset.id, '2025-01-02', [
      { key: 'v1', data: { id: 'v1' } },
    ], { apiTotal: 5 });

    const config = [{
      id: 'fetch-test',
      name: 'Fetch test',
      check: 'fetch-complete',
    }];

    const results = runAssertions('2025-01-02', config);
    assert.equal(results.length, 1);
    assert.equal(results[0].passed, false);
    assert.ok(results[0].message.includes('Fetch incomplete'));
  });

  it('stores results in the database', () => {
    insertSnapshot(dataset.id, '2025-01-02', [
      { key: 'v1', data: { id: 'v1' } },
    ], { apiTotal: 1 });

    const config = [{
      id: 'db-store-test',
      name: 'DB store test',
      check: 'fetch-complete',
    }];

    runAssertions('2025-01-02', config);

    const results = getAssertionResults('2025-01-02');
    assert.ok(results.length >= 1);
    assert.equal(results[0].assertion_id, 'db-store-test');
  });
});
