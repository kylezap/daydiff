/**
 * DevGrid API Dataset Definitions
 *
 * Each entry describes a dataset to fetch daily from the DevGrid API.
 * The fetcher auto-paginates responses that follow the DevGrid pattern:
 *   { data: [...], pagination: { page, limit, total, totalPages } }
 *
 * Fields:
 *   name       — Unique human-readable name (used in DB + dashboard)
 *   endpoint   — API path appended to API_BASE_URL
 *   rowKey     — Field in each row used as its unique identifier
 *   paginated  — Whether the endpoint returns paginated results (default: true)
 *   params     — Optional default query parameters
 *   headers    — Optional extra headers for this endpoint
 *   transform  — Optional function to normalize the response into a row array.
 *                Receives the parsed JSON body, must return an array of objects.
 *                Default: assumes { data: [...] } shape.
 */

const datasets = [
  // ──────────────────────────────────────────────────────────────
  // Core inventory datasets — track your catalog day over day
  // ──────────────────────────────────────────────────────────────
  {
    name: 'components',
    endpoint: '/components',
    rowKey: 'id',
    paginated: true,
  },
  {
    name: 'applications',
    endpoint: '/applications',
    rowKey: 'id',
    paginated: true,
  },
  {
    name: 'repositories',
    endpoint: '/repositories',
    rowKey: 'id',
    paginated: true,
  },
  {
    name: 'entities',
    endpoint: '/entities',
    rowKey: 'id',
    paginated: true,
  },
  {
    name: 'relationships',
    endpoint: '/relationships',
    rowKey: 'id',
    paginated: true,
  },
  {
    name: 'entity-mappings',
    endpoint: '/entity-mappings',
    rowKey: 'id',
    paginated: true,
  },

  // ──────────────────────────────────────────────────────────────
  // Security & compliance — critical for regulated environments
  // ──────────────────────────────────────────────────────────────
  {
    name: 'vulnerabilities',
    endpoint: '/vulnerabilities',
    rowKey: 'id',
    paginated: true,
  },
  {
    name: 'vulnerability-projects',
    endpoint: '/vulnerability-projects',
    rowKey: 'id',
    paginated: true,
  },
  {
    name: 'vulnerability-identifiers',
    endpoint: '/vulnerability-identifiers',
    rowKey: 'id',
    paginated: true,
  },
  {
    name: 'incidents',
    endpoint: '/incidents',
    rowKey: 'id',
    paginated: true,
  },

  // ──────────────────────────────────────────────────────────────
  // Developer activity
  // ──────────────────────────────────────────────────────────────
  {
    name: 'committers',
    endpoint: '/committers',
    rowKey: 'id',
    paginated: true,
  },

  // ──────────────────────────────────────────────────────────────
  // Infrastructure
  // ──────────────────────────────────────────────────────────────
  {
    name: 'blueprints',
    endpoint: '/blueprints',
    rowKey: 'id',
    paginated: true,
  },
  {
    name: 'resources',
    endpoint: '/resources',
    rowKey: 'id',
    paginated: true,
  },

  // ──────────────────────────────────────────────────────────────
  // API Catalog
  // ──────────────────────────────────────────────────────────────
  {
    name: 'api-catalog-apis',
    endpoint: '/api-catalog/apis',
    rowKey: 'id',
    paginated: true,
  },
  {
    name: 'api-catalog-policies',
    endpoint: '/api-catalog/policies',
    rowKey: 'id',
    paginated: true,
  },
  {
    name: 'api-catalog-compliance-reports',
    endpoint: '/api-catalog/compliance-reports',
    rowKey: 'id',
    paginated: true,
  },

  // ──────────────────────────────────────────────────────────────
  // Metrics — snapshot current values
  // Uncomment if you want to track metric definitions
  // ──────────────────────────────────────────────────────────────
  // {
  //   name: 'metrics',
  //   endpoint: '/metrics',
  //   rowKey: 'id',
  //   paginated: true,
  // },
  // {
  //   name: 'metrics-facts',
  //   endpoint: '/metrics/facts',
  //   rowKey: 'id',
  //   paginated: true,
  // },
];

export default datasets;
