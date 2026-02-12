const BASE = '/api';

async function apiFetch(path, params = {}) {
  const url = new URL(path, window.location.origin);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') {
      url.searchParams.set(k, String(v));
    }
  }

  const res = await fetch(url.toString());
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `API error: ${res.status}`);
  }
  return res.json();
}

export async function fetchDatasets() {
  const { data } = await apiFetch(`${BASE}/datasets`);
  return data;
}

export async function fetchDates() {
  const { data } = await apiFetch(`${BASE}/dates`);
  return data;
}

export async function fetchDiffs(datasetId, limit) {
  const { data } = await apiFetch(`${BASE}/diffs`, { dataset_id: datasetId, limit });
  return data;
}

export async function fetchDiff(id) {
  const { data } = await apiFetch(`${BASE}/diffs/${id}`);
  return data;
}

export async function fetchDiffItems(id, changeType) {
  const { data } = await apiFetch(`${BASE}/diffs/${id}/items`, { change_type: changeType });
  return data;
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

export async function fetchSummary(date) {
  const result = await apiFetch(`${BASE}/summary`, { date });
  return result;
}

export async function fetchTrend(days, datasetId) {
  const { data } = await apiFetch(`${BASE}/trend`, { days, dataset_id: datasetId });
  return data;
}
