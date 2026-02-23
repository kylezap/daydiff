import { apiRequest } from './client.mjs';
import datasets from '../../config/datasets.mjs';
import { ensureDataset } from '../db/index.mjs';
import {
  insertSnapshot,
  createEmptySnapshot,
  insertSnapshotRowsBatch,
  finalizeSnapshot,
  getSnapshotRowCount,
} from '../db/queries.mjs';
import { log, warn, error } from '../lib/logger.mjs';

/**
 * Get today's date as YYYY-MM-DD.
 */
function today() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Maximum pages to fetch as a safety valve.
 */
const MAX_ITERATIONS = 2000;

/**
 * Extract rows from a response body using a transform or default logic.
 */
function extractRows(body, transform, name) {
  if (transform) return transform(body);
  if (Array.isArray(body)) return body;
  if (body && Array.isArray(body.data)) return body.data;
  throw new Error(`Cannot extract rows from ${name} response — provide a transform function`);
}

/**
 * Extract pagination metadata from a response body.
 * Returns { total, pageSize, currentPage } or null if no pagination info found.
 */
function extractPagination(body) {
  const pag = body?.pagination || body?.meta || null;
  if (!pag) return null;

  return {
    total: pag.total ?? pag.totalCount ?? pag.count ?? 0,
    pageSize: pag.limit ?? pag.pageSize ?? pag.per_page ?? 0,
    currentPage: pag.page ?? pag.currentPage ?? 1,
    totalPages: pag.totalPages ?? pag.total_pages ?? 0,
    offset: pag.offset ?? null,
  };
}

/**
 * Fetch all pages of a paginated DevGrid API endpoint (single pass).
 *
 * When streamOptions is provided, writes each page to the DB immediately (memory bounded,
 * one batch per page — does not hold a long-lived write lock).
 *
 * Strategy:
 *   1. First request: user-provided params only (e.g. limit).
 *   2. Read pagination metadata (total, page size).
 *   3. Sequential offset pagination: offset = pageSize, then 2*pageSize, ... (no overlap).
 *
 * @param {string} endpoint
 * @param {object} params - User-provided query params (NOT pagination params)
 * @param {object} headers - Extra headers
 * @param {Function|null} transform - Optional row extraction function
 * @param {string} name - Dataset name for logging
 * @param {object} [options] - { rowKey, partitionLabel, streamOptions }
 * @returns {Promise<{rows?: object[], rowCount?: number, apiTotal: number|null, warnings: string[]}>}
 */
async function fetchAllPages(endpoint, params, headers, transform, name, options = {}) {
  const {
    rowKey = null,
    partitionLabel = '',
    streamOptions = null,
  } = options;

  const streaming = streamOptions != null;
  const diffIgnoreFields = streaming ? (streamOptions.diffIgnoreFields ?? []) : [];
  const prefix = partitionLabel ? `[${partitionLabel}] ` : '';
  const warnings = [];

  const body = await apiRequest(endpoint, { params, headers });
  const firstRows = extractRows(body, transform, name);

  if (!Array.isArray(firstRows)) {
    throw new Error(`Transform for ${name} did not return an array`);
  }

  const pag = extractPagination(body);

  if (!pag || pag.total === 0) {
    if (streaming) {
      insertSnapshotRowsBatch(streamOptions.snapshotId, firstRows, rowKey, diffIgnoreFields);
    }
    log(`[fetch] ${name}: ${prefix}${firstRows.length} records (no pagination metadata)`);
    return { rows: streaming ? null : firstRows, apiTotal: null, warnings };
  }

  const total = pag.total;
  const reportedPageSize = pag.pageSize || 100;
  const pageSize =
    firstRows.length > 0
      ? Math.min(reportedPageSize, firstRows.length)
      : reportedPageSize;

  log(`[fetch] ${name}: ${prefix}${total} total records, page size ${pageSize}`);

  if (streaming) {
    insertSnapshotRowsBatch(streamOptions.snapshotId, firstRows, rowKey, diffIgnoreFields);
  }

  if (firstRows.length >= total) {
    const rows = streaming ? null : firstRows;
    return { rows, apiTotal: total, warnings };
  }

  let allRows = streaming ? null : [...firstRows];
  let currentOffset = pageSize;
  let iteration = 1;
  const LOG_INTERVAL = 10;

  while (currentOffset < total && iteration < MAX_ITERATIONS) {
    const pageParams = { ...params, offset: currentOffset };

    try {
      const pageBody = await apiRequest(endpoint, { params: pageParams, headers });
      const pageRows = extractRows(pageBody, transform, name);

      if (!Array.isArray(pageRows) || pageRows.length === 0) break;

      if (streaming) {
        insertSnapshotRowsBatch(streamOptions.snapshotId, pageRows, rowKey, diffIgnoreFields);
        if (iteration % LOG_INTERVAL === 0) {
          const count = getSnapshotRowCount(streamOptions.snapshotId);
          log(`[fetch] ${name}: ${prefix}fetched ~${count}/${total} records (offset ${currentOffset})`);
        }
      } else {
        allRows = allRows.concat(pageRows);
        log(`[fetch] ${name}: ${prefix}fetched ~${allRows.length}/${total} records (offset ${currentOffset})`);
      }

      if (pageRows.length < pageSize) break;

      currentOffset += pageSize;
      iteration++;
    } catch (err) {
      const count = streaming ? getSnapshotRowCount(streamOptions.snapshotId) : allRows.length;
      const msg = `Pagination with offset failed (${err.message}). Got ${count}/${total} records.`;
      warn(`[fetch] ${name}: ${prefix}${msg}`);
      warnings.push(msg);
      break;
    }
  }

  if (iteration >= MAX_ITERATIONS) {
    const msg = `Hit max iteration limit (${MAX_ITERATIONS}).`;
    warn(`[fetch] ${name}: ${prefix}${msg}`);
    warnings.push(msg);
  }

  return { rows: allRows, apiTotal: total, warnings };
}

/**
 * Fetch a single dataset from the API and store it as a snapshot.
 *
 * Paginated datasets use streaming mode: rows are written to the DB as each
 * page is fetched (memory bounded). Non-paginated datasets use the legacy
 * in-memory path.
 *
 * @param {object} datasetConfig - Entry from config/datasets.mjs
 * @param {string} [date] - Override date (default: today)
 * @returns {Promise<{dataset: string, rowCount: number, snapshotId: number}>}
 */
async function fetchDataset(datasetConfig, date) {
  const {
    name,
    endpoint,
    rowKey,
    params = {},
    headers = {},
    transform = null,
    paginated = true,
    category = 'platform',
    partitionBy = null,
  } = datasetConfig;

  const diffIgnoreFields = datasetConfig.diffIgnoreFields ?? [];

  log(`[fetch] Fetching dataset: ${name} from ${endpoint}`);

  const dataset = ensureDataset(name, endpoint, rowKey, category);

  if (!paginated) {
    const body = await apiRequest(endpoint, { params, headers });
    const rows = extractRows(body, transform, name);
    if (!Array.isArray(rows)) {
      throw new Error(`[fetch] Transform for ${name} did not return an array`);
    }
    const seen = new Map();
    for (let idx = 0; idx < rows.length; idx++) {
      const row = rows[idx];
      const key = row[rowKey];
      if (key === undefined || key === null) {
        throw new Error(`[fetch] Row ${idx} in ${name} is missing row key field "${rowKey}"`);
      }
      seen.set(String(key), row);
    }
    const normalizedRows = Array.from(seen, ([key, data]) => ({ key, data }));
    const result = insertSnapshot(dataset.id, date, normalizedRows, {
      apiTotal: null,
      fetchWarnings: null,
      diffIgnoreFields,
    });
    log(`[fetch] ${name}: stored ${result.rowCount} rows for ${date}`);
    return { dataset: name, datasetId: dataset.id, rowCount: result.rowCount, snapshotId: result.snapshotId };
  }

  const snapshotId = createEmptySnapshot(dataset.id, date);
  const streamOptions = { snapshotId, rowKey, diffIgnoreFields };
  const fetchOptions = { rowKey, streamOptions };

  let apiTotal = null;
  const warnings = [];

  if (partitionBy) {
    const { param, values } = partitionBy;
    log(`[fetch] ${name}: partitioned by ${param} (${values.join(', ')})`);

    for (const value of values) {
      const partParams = { ...params, [param]: value };
      const result = await fetchAllPages(endpoint, partParams, headers, transform, name, {
        ...fetchOptions,
        partitionLabel: value,
      });
      if (result.apiTotal != null) apiTotal = (apiTotal ?? 0) + result.apiTotal;
      warnings.push(...result.warnings);
      const count = getSnapshotRowCount(snapshotId);
      log(`[fetch] ${name}: severity=${value} → ${result.rows?.length ?? 'streamed'} rows (total unique: ${count})`);
    }

    if (apiTotal != null) {
      const count = getSnapshotRowCount(snapshotId);
      const pct = ((count / apiTotal) * 100).toFixed(1);
      log(`[fetch] ${name}: partitioned coverage ${count}/${apiTotal} (${pct}%)`);
    }
  } else {
    const result = await fetchAllPages(endpoint, params, headers, transform, name, fetchOptions);
    apiTotal = result.apiTotal;
    warnings.push(...result.warnings);
  }

  const fetchWarnings = warnings.length > 0 ? warnings.join('; ') : null;
  const { rowCount } = finalizeSnapshot(snapshotId, apiTotal, fetchWarnings);

  log(`[fetch] ${name}: stored ${rowCount} rows for ${date}`);

  return {
    dataset: name,
    datasetId: dataset.id,
    rowCount,
    snapshotId,
  };
}

/**
 * Safely fetch a single dataset, catching and logging errors.
 * @returns {Promise<object>} Result or error object
 */
async function safeFetchDataset(ds, fetchDate) {
  try {
    return await fetchDataset(ds, fetchDate);
  } catch (err) {
    error(`[fetch] ERROR fetching ${ds.name}: ${err.message}`);
    return {
      dataset: ds.name,
      error: err.message,
      rowCount: 0,
    };
  }
}

/**
 * Fetch all configured datasets and store snapshots.
 *
 * Strategy: platform datasets first (concurrently — they're small), then
 * vulnerability datasets one at a time to avoid overwhelming the API.
 *
 * @param {string} [date] - Override date (default: today)
 * @returns {Promise<Array<{dataset: string, rowCount: number, snapshotId: number}>>}
 */
export async function fetchAllDatasets(date) {
  const fetchDate = date || today();

  const platformDs = datasets.filter(ds => ds.category === 'platform');
  const vulnDs = datasets.filter(ds => ds.category !== 'platform');

  log(`\n[fetch] Starting fetch for ${fetchDate}`);
  log(`[fetch] ${datasets.length} dataset(s): ${platformDs.length} platform (parallel), ${vulnDs.length} vulnerability (sequential)\n`);

  // ── Phase 1: Platform datasets in parallel (small, fast) ──────
  log('[fetch] Phase 1: Platform datasets...');
  const platformResults = await Promise.all(
    platformDs.map(ds => safeFetchDataset(ds, fetchDate))
  );

  // ── Phase 2: Vulnerability datasets one at a time ─────────────
  log('\n[fetch] Phase 2: Vulnerability datasets (sequential)...');
  const vulnResults = [];
  for (const ds of vulnDs) {
    const result = await safeFetchDataset(ds, fetchDate);
    vulnResults.push(result);
  }

  const results = [...platformResults, ...vulnResults];
  const successCount = results.filter(r => !r.error).length;
  log(`\n[fetch] Complete: ${successCount}/${datasets.length} datasets fetched successfully`);

  return results;
}
