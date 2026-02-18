import { apiRequest } from './client.mjs';
import datasets from '../../config/datasets.mjs';
import { ensureDataset } from '../db/index.mjs';
import { insertSnapshot } from '../db/queries.mjs';
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
 * Fetch all pages of a paginated DevGrid API endpoint.
 *
 * Strategy:
 *   1. First request: send ONLY the user-provided params (no page/limit/offset).
 *      The DevGrid API treats unknown query params as column filters, so we
 *      must not send pagination params the API doesn't expect.
 *   2. Read the pagination metadata from the response to learn the page size
 *      and total count.
 *   3. If there are more records, paginate using `offset` (the most common
 *      server-side pattern that doesn't conflict with column names).
 *      If `offset` fails, fall back to accepting truncated results with a warning.
 *
 * When options.passes > 1, runs the full pagination N times and merges results
 * by rowKey. The API ordering is non-deterministic, so multiple passes capture
 * records that slip through on any single pass. Stops early if a pass adds no
 * new unique records (convergence).
 *
 * @param {string} endpoint
 * @param {object} params - User-provided query params (NOT pagination params)
 * @param {object} headers - Extra headers
 * @param {Function|null} transform - Optional row extraction function
 * @param {string} name - Dataset name for logging
 * @param {object} [options] - { passes: 1, rowKey: null }
 * @returns {Promise<{rows: object[], apiTotal: number|null, warnings: string[]}>}
 */
async function fetchAllPages(endpoint, params, headers, transform, name, options = {}) {
  const { passes = 1, rowKey = null, partitionLabel = '' } = options;

  async function doOnePass(passLabel = partitionLabel) {
    const prefix = partitionLabel ? `[${partitionLabel}] ` : '';
    const warnings = [];

    // ── First request: no pagination params ───────────────────────
    const body = await apiRequest(endpoint, { params, headers });
    const firstRows = extractRows(body, transform, name);

    if (!Array.isArray(firstRows)) {
      throw new Error(`Transform for ${name} did not return an array`);
    }

    const pag = extractPagination(body);

    // No pagination metadata → single-page response
    if (!pag || pag.total === 0) {
      log(`[fetch] ${name}: ${prefix}${firstRows.length} records (no pagination metadata)`);
      return { rows: firstRows, apiTotal: null, warnings };
    }

    const total = pag.total;
    const reportedPageSize = pag.pageSize || 100;
    const pageSize =
      firstRows.length > 0
        ? Math.min(reportedPageSize, firstRows.length)
        : reportedPageSize;

    log(`[fetch] ${name}: ${prefix}${total} total records, page size ${pageSize}`);

    if (firstRows.length >= total) {
      return { rows: firstRows, apiTotal: total, warnings };
    }

    // ── Paginate with overlapping offset ────────────────────────────
    const OVERLAP_RATIO = 0.25;
    const stride = Math.max(1, Math.floor(pageSize * (1 - OVERLAP_RATIO)));

    let allRows = [...firstRows];
    let currentOffset = pageSize;
    let iteration = 1;

    while (currentOffset < total && iteration < MAX_ITERATIONS) {
      const pageParams = { ...params, offset: currentOffset };

      try {
        const pageBody = await apiRequest(endpoint, { params: pageParams, headers });
        const pageRows = extractRows(pageBody, transform, name);

        if (!Array.isArray(pageRows) || pageRows.length === 0) break;

        allRows = allRows.concat(pageRows);
        log(`[fetch] ${name}: ${prefix}fetched ~${allRows.length}/${total} records (offset ${currentOffset})`);

        if (pageRows.length < pageSize) break;

        currentOffset += stride;
        iteration++;
      } catch (err) {
        const msg = `Pagination with offset failed (${err.message}). Got ${allRows.length}/${total} records.`;
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

  // Single pass: original behavior
  if (passes === 1) {
    return doOnePass();
  }

  // Multi-pass: merge results by rowKey, stop on convergence
  if (!rowKey) {
    throw new Error(`Multi-pass fetch for ${name} requires rowKey in options`);
  }

  const merged = new Map();
  let apiTotal = null;
  const allWarnings = [];

  for (let pass = 1; pass <= passes; pass++) {
    const partitionLabel = passes > 1 ? `pass ${pass}/${passes}` : '';
    const result = await doOnePass(partitionLabel);

    if (apiTotal === null) apiTotal = result.apiTotal;
    allWarnings.push(...result.warnings);

    const beforeSize = merged.size;
    for (const row of result.rows) {
      const key = row[rowKey];
      if (key !== undefined && key !== null) {
        merged.set(String(key), row);
      }
    }
    const added = merged.size - beforeSize;

    if (pass > 1) {
      log(`[fetch] ${name}: pass ${pass} added ${added} unique records (total unique: ${merged.size})`);
      if (added === 0) {
        log(`[fetch] ${name}: convergence on pass ${pass}, stopping early`);
        break;
      }
    }
  }

  const rows = Array.from(merged.values());
  if (apiTotal != null && rows.length > 0) {
    const pct = ((rows.length / apiTotal) * 100).toFixed(1);
    log(`[fetch] ${name}: coverage ${rows.length}/${apiTotal} (${pct}%)`);
  }

  return { rows, apiTotal, warnings: allWarnings };
}

/**
 * Fetch a single dataset from the API and store it as a snapshot.
 *
 * When partitionBy is configured (e.g. severity), fetches each partition
 * separately and merges results. Reduces page boundaries and improves
 * coverage for datasets with unstable API ordering.
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
    passes = 1,
  } = datasetConfig;

  log(`[fetch] Fetching dataset: ${name} from ${endpoint}`);

  let rows;
  let apiTotal = null;
  const warnings = [];

  const fetchOptions = { passes, rowKey };

  if (paginated && partitionBy) {
    // Severity-partitioned fetch: one request per partition value, then merge
    const { param, values } = partitionBy;
    const merged = new Map();
    let totalApiTotal = 0;

    log(`[fetch] ${name}: partitioned by ${param} (${values.join(', ')})`);

    for (const value of values) {
      const partParams = { ...params, [param]: value };
      const result = await fetchAllPages(endpoint, partParams, headers, transform, name, {
        ...fetchOptions,
        partitionLabel: value,
      });

      const beforeSize = merged.size;
      for (const row of result.rows) {
        const k = row[rowKey];
        if (k !== undefined && k !== null) merged.set(String(k), row);
      }
      const added = merged.size - beforeSize;

      if (result.apiTotal != null) totalApiTotal += result.apiTotal;
      warnings.push(...result.warnings);

      log(`[fetch] ${name}: severity=${value} → ${result.rows.length} rows (+${added} unique, total unique: ${merged.size})`);
    }

    rows = Array.from(merged.values());
    apiTotal = totalApiTotal > 0 ? totalApiTotal : null;

    if (apiTotal != null && rows.length > 0) {
      const pct = ((rows.length / apiTotal) * 100).toFixed(1);
      log(`[fetch] ${name}: partitioned coverage ${rows.length}/${apiTotal} (${pct}%)`);
    }
  } else if (paginated) {
    const result = await fetchAllPages(endpoint, params, headers, transform, name, fetchOptions);
    rows = result.rows;
    apiTotal = result.apiTotal;
    warnings.push(...result.warnings);
  } else {
    // Single non-paginated request
    const body = await apiRequest(endpoint, { params, headers });
    rows = extractRows(body, transform, name);
  }

  if (!Array.isArray(rows)) {
    throw new Error(`[fetch] Transform for ${name} did not return an array`);
  }

  // Normalize into {key, data} pairs, deduplicating by row key.
  // Offset-based pagination can return duplicates if the API lacks stable ordering.
  const seen = new Map();
  for (let idx = 0; idx < rows.length; idx++) {
    const row = rows[idx];
    const key = row[rowKey];
    if (key === undefined || key === null) {
      throw new Error(
        `[fetch] Row ${idx} in ${name} is missing row key field "${rowKey}"`
      );
    }
    seen.set(String(key), row); // last occurrence wins
  }
  const normalizedRows = Array.from(seen, ([key, data]) => ({ key, data }));

  if (normalizedRows.length < rows.length) {
    const msg = `Deduplicated ${rows.length} → ${normalizedRows.length} rows (${rows.length - normalizedRows.length} duplicate keys removed)`;
    warn(`[fetch] ${name}: ${msg}`);
    warnings.push(msg);
  }

  // Ensure dataset record exists in DB
  const dataset = ensureDataset(name, endpoint, rowKey, category);

  // Store snapshot with fetch metadata
  const fetchWarnings = warnings.length > 0 ? warnings.join('; ') : null;
  const result = insertSnapshot(dataset.id, date, normalizedRows, {
    apiTotal,
    fetchWarnings,
    diffIgnoreFields: datasetConfig.diffIgnoreFields ?? [],
  });

  log(`[fetch] ${name}: stored ${result.rowCount} rows for ${date}`);

  return {
    dataset: name,
    datasetId: dataset.id,
    rowCount: result.rowCount,
    snapshotId: result.snapshotId,
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
