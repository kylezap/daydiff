import { apiRequest } from './client.mjs';
import datasets from '../../config/datasets.mjs';
import { ensureDataset } from '../db/index.mjs';
import { insertSnapshot } from '../db/queries.mjs';

/**
 * Get today's date as YYYY-MM-DD.
 */
function today() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Maximum pages to fetch as a safety valve.
 */
const MAX_ITERATIONS = 500;

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
 * @returns {Promise<object[]>} All rows across all pages
 */
async function fetchAllPages(endpoint, params, headers, transform, name) {
  // ── First request: no pagination params ───────────────────────
  const body = await apiRequest(endpoint, { params, headers });
  const firstRows = extractRows(body, transform, name);

  if (!Array.isArray(firstRows)) {
    throw new Error(`Transform for ${name} did not return an array`);
  }

  const pag = extractPagination(body);

  // No pagination metadata → single-page response
  if (!pag || pag.total === 0) {
    console.log(`[fetch] ${name}: ${firstRows.length} records (no pagination metadata)`);
    return firstRows;
  }

  const total = pag.total;
  const pageSize = pag.pageSize || firstRows.length || 100;

  console.log(`[fetch] ${name}: ${total} total records, page size ${pageSize}`);

  // If we already have everything, done
  if (firstRows.length >= total) {
    return firstRows;
  }

  // ── Paginate with offset ──────────────────────────────────────
  let allRows = [...firstRows];
  let iteration = 1;

  while (allRows.length < total && iteration < MAX_ITERATIONS) {
    const offset = allRows.length;
    const pageParams = { ...params, offset };

    try {
      const pageBody = await apiRequest(endpoint, { params: pageParams, headers });
      const pageRows = extractRows(pageBody, transform, name);

      if (!Array.isArray(pageRows) || pageRows.length === 0) {
        // No more rows returned — stop
        break;
      }

      allRows = allRows.concat(pageRows);
      console.log(`[fetch] ${name}: fetched ${allRows.length}/${total} records`);

      // If we got fewer than expected, we're done
      if (pageRows.length < pageSize) break;

      iteration++;
    } catch (err) {
      // If offset param fails (e.g. API doesn't support it), accept what we have
      console.warn(
        `[fetch] ${name}: pagination with offset failed (${err.message}). ` +
        `Got ${allRows.length}/${total} records.`
      );
      break;
    }
  }

  if (iteration >= MAX_ITERATIONS) {
    console.warn(`[fetch] ${name}: hit max iteration limit (${MAX_ITERATIONS})`);
  }

  if (allRows.length < total) {
    console.warn(
      `[fetch] ${name}: retrieved ${allRows.length} of ${total} total records ` +
      `(${total - allRows.length} missing — API may not support offset pagination)`
    );
  }

  return allRows;
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

  console.log(`[fetch] Fetching dataset: ${name} from ${endpoint}`);

  let rows;
  if (paginated) {
    rows = await fetchAllPages(endpoint, params, headers, transform, name);
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
    console.warn(
      `[fetch] ${name}: deduplicated ${rows.length} → ${normalizedRows.length} rows ` +
      `(${rows.length - normalizedRows.length} duplicate keys removed)`
    );
  }

  // Ensure dataset record exists in DB
  const dataset = ensureDataset(name, endpoint, rowKey, category);

  // Store snapshot
  const result = insertSnapshot(dataset.id, date, normalizedRows);

  console.log(`[fetch] ${name}: stored ${result.rowCount} rows for ${date}`);

  return {
    dataset: name,
    datasetId: dataset.id,
    rowCount: result.rowCount,
    snapshotId: result.snapshotId,
  };
}

/**
 * Default number of datasets to fetch concurrently.
 * Each dataset still paginates sequentially, but multiple datasets run in parallel.
 */
const CONCURRENCY = 3;

/**
 * Run async tasks with a concurrency limit.
 * @param {Array<() => Promise>} tasks - Array of zero-arg async functions
 * @param {number} limit - Max concurrent tasks
 * @returns {Promise<Array>} Results in the same order as tasks
 */
async function runWithConcurrency(tasks, limit) {
  const results = new Array(tasks.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < tasks.length) {
      const idx = nextIndex++;
      results[idx] = await tasks[idx]();
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/**
 * Fetch all configured datasets and store snapshots.
 * Runs up to CONCURRENCY datasets in parallel.
 *
 * @param {string} [date] - Override date (default: today)
 * @returns {Promise<Array<{dataset: string, rowCount: number, snapshotId: number}>>}
 */
export async function fetchAllDatasets(date) {
  const fetchDate = date || today();
  console.log(`\n[fetch] Starting fetch for ${fetchDate}`);
  console.log(`[fetch] ${datasets.length} dataset(s) configured, concurrency: ${CONCURRENCY}\n`);

  const tasks = datasets.map((ds) => async () => {
    try {
      return await fetchDataset(ds, fetchDate);
    } catch (err) {
      console.error(`[fetch] ERROR fetching ${ds.name}: ${err.message}`);
      return {
        dataset: ds.name,
        error: err.message,
        rowCount: 0,
      };
    }
  });

  const results = await runWithConcurrency(tasks, CONCURRENCY);

  const successCount = results.filter(r => !r.error).length;
  console.log(`\n[fetch] Complete: ${successCount}/${datasets.length} datasets fetched successfully`);

  return results;
}
