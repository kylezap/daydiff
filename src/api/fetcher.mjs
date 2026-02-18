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
 * @param {string} endpoint
 * @param {object} params - User-provided query params (NOT pagination params)
 * @param {object} headers - Extra headers
 * @param {Function|null} transform - Optional row extraction function
 * @param {string} name - Dataset name for logging
 * @returns {Promise<{rows: object[], apiTotal: number|null, warnings: string[]}>}
 */
async function fetchAllPages(endpoint, params, headers, transform, name) {
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
    log(`[fetch] ${name}: ${firstRows.length} records (no pagination metadata)`);
    return { rows: firstRows, apiTotal: null, warnings };
  }

  const total = pag.total;
  // Use the smaller of: reported page size vs actual rows received.
  // If the API returns fewer rows than requested (server cap, rate limit, etc.),
  // we must use the actual count for offset math or we'll skip records.
  const reportedPageSize = pag.pageSize || 100;
  const pageSize =
    firstRows.length > 0
      ? Math.min(reportedPageSize, firstRows.length)
      : reportedPageSize;

  log(`[fetch] ${name}: ${total} total records, page size ${pageSize}`);

  // If we already have everything, done
  if (firstRows.length >= total) {
    return { rows: firstRows, apiTotal: total, warnings };
  }

  // ── Paginate with overlapping offset ────────────────────────────
  // TODO: Once DevGrid adds a sort parameter, pass sort=id here and
  //       remove the overlap logic.  See README.md "Known Issues" section.
  //
  // The DevGrid API doesn't support sorting, so offset-based pagination
  // is unstable — rows can shift between pages.  We overlap each page by
  // 10% of the page size so shifted rows are still captured.  Duplicates
  // are removed downstream by the dedup step in fetchDataset().
  const OVERLAP_RATIO = 0.10;
  const stride = Math.max(1, Math.floor(pageSize * (1 - OVERLAP_RATIO)));

  let allRows = [...firstRows];
  let currentOffset = pageSize; // first page already covers 0..pageSize-1
  let iteration = 1;

  while (currentOffset < total && iteration < MAX_ITERATIONS) {
    const pageParams = { ...params, offset: currentOffset };

    try {
      const pageBody = await apiRequest(endpoint, { params: pageParams, headers });
      const pageRows = extractRows(pageBody, transform, name);

      if (!Array.isArray(pageRows) || pageRows.length === 0) {
        // No more rows returned — stop
        break;
      }

      allRows = allRows.concat(pageRows);
      log(`[fetch] ${name}: fetched ~${allRows.length}/${total} records (offset ${currentOffset})`);

      // If we got fewer than expected, we're done
      if (pageRows.length < pageSize) break;

      currentOffset += stride;
      iteration++;
    } catch (err) {
      // If offset param fails (e.g. API doesn't support it), accept what we have
      const msg = `Pagination with offset failed (${err.message}). Got ${allRows.length}/${total} records.`;
      warn(`[fetch] ${name}: ${msg}`);
      warnings.push(msg);
      break;
    }
  }

  if (iteration >= MAX_ITERATIONS) {
    const msg = `Hit max iteration limit (${MAX_ITERATIONS}).`;
    warn(`[fetch] ${name}: ${msg}`);
    warnings.push(msg);
  }

  return { rows: allRows, apiTotal: total, warnings };
}

/**
 * Fetch a single dataset from the API and store it as a snapshot.
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
  } = datasetConfig;

  log(`[fetch] Fetching dataset: ${name} from ${endpoint}`);

  let rows;
  let apiTotal = null;
  const warnings = [];

  if (paginated) {
    const result = await fetchAllPages(endpoint, params, headers, transform, name);
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
