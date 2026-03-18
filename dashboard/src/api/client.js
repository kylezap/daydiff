const BASE = '/api';

/**
 * Fetch dashboard feature flags and config.
 * @returns {{ qualityTabEnabled: boolean }}
 */
export async function fetchConfig(options = {}) {
  const { data } = await apiFetch(`${BASE}/config`, {}, options);
  return data;
}

async function apiFetch(path, params = {}, options = {}) {
  const url = new URL(path, window.location.origin);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') {
      url.searchParams.set(k, String(v));
    }
  }

  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : null;
  const ac = new AbortController();
  let timeoutId = null;
  let externalAbortHandler = null;
  const hasExternalSignal = !!options.signal;
  if (hasExternalSignal) {
    if (options.signal.aborted) {
      ac.abort(options.signal.reason);
    } else {
      externalAbortHandler = () => ac.abort(options.signal.reason);
      options.signal.addEventListener('abort', externalAbortHandler, { once: true });
    }
  }
  if (timeoutMs) {
    const timeoutReason = new DOMException(`Request timed out after ${timeoutMs}ms`, 'TimeoutError');
    timeoutId = setTimeout(() => ac.abort(timeoutReason), timeoutMs);
  }

  let res;
  try {
    res = await fetch(url.toString(), { signal: ac.signal });
  } catch (err) {
    if (ac.signal.aborted && ac.signal.reason?.name === 'TimeoutError') {
      throw new Error(ac.signal.reason.message);
    }
    throw err;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    if (hasExternalSignal && externalAbortHandler) {
      options.signal.removeEventListener('abort', externalAbortHandler);
    }
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `API error: ${res.status}`);
  }
  return res.json();
}

export async function fetchDatasets(category, options = {}) {
  const { data } = await apiFetch(`${BASE}/datasets`, { category }, options);
  return data;
}

export async function fetchDates(category, options = {}) {
  const { data } = await apiFetch(`${BASE}/dates`, { category }, options);
  return data;
}

export async function fetchDiffs(datasetId, limit, category, options = {}) {
  const { data } = await apiFetch(`${BASE}/diffs`, { dataset_id: datasetId, limit, category }, options);
  return data;
}

export async function fetchDiff(id) {
  const { data } = await apiFetch(`${BASE}/diffs/${id}`);
  return data;
}

/**
 * Fetch field/path change counts for a diff (top-level and nested).
 * @returns {{ topLevel: Array<{field_path: string, change_count: number}>, nested: Array<{field_path: string, change_count: number}> }}
 */
export async function fetchDiffFieldChanges(id) {
  const { data } = await apiFetch(`${BASE}/diffs/${id}/field-changes`);
  return data;
}

export async function fetchDiffItems(id, changeType) {
  const { data } = await apiFetch(`${BASE}/diffs/${id}/items`, { change_type: changeType });
  return data;
}

/**
 * Fetch IDs of all matching diff items (for cross-page selection).
 * @returns {{ ids: number[], total: number }}
 */
export async function fetchDiffItemIds(id, { changeType, search } = {}) {
  const params = {};
  if (changeType) params.change_type = changeType;
  if (search) params.search = search;
  const url = new URL(`${BASE}/diffs/${id}/items/ids`, window.location.origin);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, String(v));
  }
  const res = await fetch(url.toString());
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `API error: ${res.status}`);
  }
  return res.json();
}

/**
 * Export diff as CSV. When ids provided, exports only those rows; otherwise all matching.
 * @returns {{ blob: Blob, filename: string }}
 */
export async function exportDiffCsv(id, { changeType, search, ids } = {}) {
  const baseUrl = `${window.location.origin}${BASE}/diffs/${id}/export`;
  let res;
  if (ids && ids.length > 0) {
    res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    });
  } else {
    const params = new URLSearchParams();
    if (changeType) params.set('change_type', changeType);
    if (search) params.set('search', search);
    const qs = params.toString();
    res = await fetch(`${baseUrl}${qs ? `?${qs}` : ''}`);
  }
  if (!res.ok) throw new Error(`Export failed: ${res.status}`);
  const blob = await res.blob();
  const disp = res.headers.get('Content-Disposition') || '';
  const m = disp.match(/filename="?([^"]+)"?/);
  return { blob, filename: m ? m[1] : `diff-${id}.csv` };
}

/**
 * Fetch diff items with server-side pagination.
 * @returns {{ data: Array, pagination: { offset, limit, total } }}
 */
export async function fetchDiffItemsPage(id, { offset = 0, limit = 100, changeType, search, sort, dir } = {}) {
  return apiFetch(`${BASE}/diffs/${id}/items`, {
    offset,
    limit,
    change_type: changeType,
    search,
    sort,
    dir,
  });
}

export async function fetchSummary(date, category, options = {}) {
  const result = await apiFetch(`${BASE}/summary`, { date, category }, options);
  return result;
}

export async function fetchTrend(days, datasetId, category, options = {}) {
  const { data } = await apiFetch(`${BASE}/trend`, { days, dataset_id: datasetId, category }, options);
  return data;
}

// ─── Quality / Data-Quality Endpoints ─────────────────────────

/**
 * Fetch all quality data in one request (assertions, summary, population, flapping,
 * fieldStability, sourceSegments, referential). Use instead of 7 separate calls.
 */
export async function fetchQualityAll(params = {}, options = {}) {
  const { date, dataset_id, days, category } = params;
  const search = new URLSearchParams();
  if (date != null && date !== '') search.set('date', date);
  if (dataset_id != null && dataset_id !== '') search.set('dataset_id', dataset_id);
  if (days != null && days !== '') search.set('days', String(days));
  if (category != null && category !== '') search.set('category', category);
  const path = `${BASE}/quality/all${search.toString() ? `?${search}` : ''}`;
  const reqOpts = {
    ...options,
    timeoutMs: options.timeoutMs ?? 20000,
  };
  const { data } = await apiFetch(path, {}, reqOpts);
  return data;
}

export async function fetchPopulation(days, datasetId, category, options = {}) {
  const { data } = await apiFetch(`${BASE}/population`, { days, dataset_id: datasetId, category }, options);
  return data;
}

export async function fetchVulnerabilityDistribution(date, category, options = {}) {
  const { data } = await apiFetch(`${BASE}/vulnerability/distribution`, { date, category }, options);
  return data;
}

export async function fetchFlapping(datasetId, days, category, options = {}) {
  const { data } = await apiFetch(`${BASE}/quality/flapping`, { dataset_id: datasetId, days, category }, options);
  return data;
}

export async function fetchFieldStability(datasetId, days, category, options = {}) {
  const { data } = await apiFetch(`${BASE}/quality/field-stability`, { dataset_id: datasetId, days, category }, options);
  return data;
}

export async function fetchSourceSegments(datasetId, date, category, options = {}) {
  const { data } = await apiFetch(`${BASE}/quality/source-segments`, { dataset_id: datasetId, date, category }, options);
  return data;
}

/**
 * @param {string} [date] - Optional YYYY-MM-DD. When omitted, backend returns latest.
 */
export async function fetchReferential(date, options = {}) {
  const params = date != null && date !== '' ? { date } : {};
  const { data } = await apiFetch(`${BASE}/quality/referential`, params, options);
  return data;
}

/**
 * @param {string} [date] - Optional YYYY-MM-DD. When omitted, backend returns latest.
 */
export async function fetchAssertions(date, options = {}) {
  const params = date != null && date !== '' ? { date } : {};
  const { data } = await apiFetch(`${BASE}/quality/assertions`, params, options);
  return data;
}

export async function fetchAssertionHistory(assertionId, days, options = {}) {
  const { data } = await apiFetch(`${BASE}/quality/assertions/history`, { assertion_id: assertionId, days }, options);
  return data;
}

export async function fetchAssertionSummary(days, options = {}) {
  const { data } = await apiFetch(`${BASE}/quality/assertions/summary`, { days }, options);
  return data;
}

// ─── Executive Report ────────────────────────────────────────────

/**
 * @param {string} [date] - Optional YYYY-MM-DD. When omitted, returns latest.
 */
export async function fetchReport(date) {
  const params = date != null && date !== '' ? { date } : {};
  const { data } = await apiFetch(`${BASE}/report`, params);
  return data;
}

export async function fetchReportDates() {
  const { data } = await apiFetch(`${BASE}/report/dates`);
  return data;
}
