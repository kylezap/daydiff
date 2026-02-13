/**
 * Dataset Definitions
 *
 * Two categories of datasets:
 *
 *   platform      — Core DevGrid resources (applications, components, repositories).
 *                   Tracked as-is for daily change monitoring.
 *
 *   vulnerability  — Vulnerabilities scoped per tracked asset from config/assets.mjs.
 *                   Each asset becomes its own dataset fetching
 *                   GET /vulnerabilities?vulnerableId=<uuid>.
 *
 * To add a new tracked application, edit config/assets.mjs — not this file.
 */

import assets from './assets.mjs';

// ─── Platform datasets ──────────────────────────────────────────

const platformDatasets = [
  {
    name: 'applications',
    endpoint: '/applications',
    rowKey: 'id',
    paginated: true,
    category: 'platform',
  },
  {
    name: 'components',
    endpoint: '/components',
    rowKey: 'id',
    paginated: true,
    category: 'platform',
  },
  {
    name: 'repositories',
    endpoint: '/repositories',
    rowKey: 'id',
    paginated: true,
    category: 'platform',
  },
];

// ─── Vulnerability datasets (one per tracked asset) ─────────────

/**
 * Page size for vulnerability fetches.
 * The DevGrid default is 10, which is very slow for 1k+ records.
 * 100 cuts API calls by 10x while staying within typical API limits.
 */
const VULN_PAGE_SIZE = 500;

const vulnerabilityDatasets = assets.map(({ name, vulnerableId }) => ({
  name: `vulns-${name}`,
  endpoint: '/vulnerabilities',
  rowKey: 'id',
  paginated: true,
  params: { vulnerableId, limit: VULN_PAGE_SIZE },
  category: 'vulnerability',
}));

// ─── Combined export ────────────────────────────────────────────

const datasets = [...platformDatasets, ...vulnerabilityDatasets];

export default datasets;
