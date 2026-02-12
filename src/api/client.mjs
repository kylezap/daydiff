import { Agent, ProxyAgent, request } from 'undici';
import { readFileSync } from 'fs';
import config from '../../config/default.mjs';

let _dispatcher = null;

// ─── Retry configuration ────────────────────────────────────────
const MAX_RETRIES = 4;
const BASE_DELAY_MS = 500;       // 500ms → 1s → 2s → 4s
const MAX_DELAY_MS = 30_000;     // Cap at 30 seconds (for large Retry-After)
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const RETRYABLE_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT',
]);

/**
 * Sleep for a given number of milliseconds.
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Calculate delay for retry attempt. Respects Retry-After header for 429s.
 * Uses exponential backoff with jitter for everything else.
 */
function retryDelay(attempt, retryAfterHeader) {
  // If server tells us when to retry, respect it
  if (retryAfterHeader) {
    const seconds = parseInt(retryAfterHeader, 10);
    if (!isNaN(seconds)) {
      return Math.min(seconds * 1000, MAX_DELAY_MS);
    }
  }
  // Exponential backoff with jitter: base * 2^attempt * (0.5..1.5)
  const exponential = BASE_DELAY_MS * Math.pow(2, attempt);
  const jitter = 0.5 + Math.random();
  return Math.min(exponential * jitter, MAX_DELAY_MS);
}

/**
 * Determine if an error is retryable.
 */
function isRetryable(err) {
  if (err.statusCode && RETRYABLE_STATUS.has(err.statusCode)) return true;
  if (err.code && RETRYABLE_CODES.has(err.code)) return true;
  return false;
}

// ─── Dispatcher ─────────────────────────────────────────────────

/**
 * Build the undici dispatcher with proxy and SSL settings.
 */
function getDispatcher() {
  if (_dispatcher) return _dispatcher;

  const tlsOptions = {};

  // Custom CA certificate
  if (config.ssl.caCert) {
    tlsOptions.ca = config.ssl.caCert;
  }

  // Disable TLS verification (last resort)
  if (!config.ssl.strict) {
    console.warn(
      '\n⚠️  WARNING: STRICT_SSL is disabled. TLS certificate verification is OFF.\n' +
      '   This is insecure and should only be used for debugging.\n'
    );
    tlsOptions.rejectUnauthorized = false;
  }

  const connectOptions = Object.keys(tlsOptions).length > 0
    ? { connect: tlsOptions }
    : {};

  // Proxy configuration
  const proxyUrl = config.proxy.httpsProxy || config.proxy.httpProxy;
  if (proxyUrl) {
    console.log(`[api] Using proxy: ${proxyUrl}`);
    _dispatcher = new ProxyAgent({
      uri: proxyUrl,
      ...connectOptions,
    });
  } else {
    _dispatcher = new Agent(connectOptions);
  }

  return _dispatcher;
}

/**
 * Build authorization header based on config.
 * DevGrid API uses "x-api-key" header (per OpenAPI spec securitySchemes).
 */
function getAuthHeader() {
  const { apiKey, authType } = config.api;
  if (!apiKey) return {};

  switch (authType.toLowerCase()) {
    case 'bearer':
      return { Authorization: `Bearer ${apiKey}` };
    case 'basic':
      return { Authorization: `Basic ${apiKey}` };
    case 'apikey':
      return { 'x-api-key': apiKey };
    default:
      return { Authorization: `Bearer ${apiKey}` };
  }
}

// ─── Core request with retry ────────────────────────────────────

/**
 * Execute a single HTTP request (no retry). Returns { statusCode, body, headers }.
 */
async function executeRequest(url, method, requestHeaders) {
  const dispatcher = getDispatcher();

  const response = await request(url, {
    method,
    headers: requestHeaders,
    dispatcher,
  });

  const { statusCode, headers: respHeaders } = response;

  // Read body as text first to handle non-JSON responses safely
  const rawBody = await response.body.text();

  // Try to parse as JSON
  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    // Response is not JSON (HTML error page, plain text, etc.)
    if (statusCode < 200 || statusCode >= 300) {
      const preview = rawBody.slice(0, 200).replace(/\n/g, ' ').trim();
      const error = new Error(
        `API request failed: ${statusCode} ${method} ${new URL(url).pathname} (non-JSON: "${preview}")`
      );
      error.statusCode = statusCode;
      error.body = rawBody;
      throw error;
    }
    throw new Error(
      `API returned non-JSON response for ${method} ${new URL(url).pathname} (status ${statusCode})`
    );
  }

  if (statusCode < 200 || statusCode >= 300) {
    const msg = body?.message || body?.error || JSON.stringify(body).slice(0, 200);
    const error = new Error(
      `API request failed: ${statusCode} ${method} ${new URL(url).pathname} — ${msg}`
    );
    error.statusCode = statusCode;
    error.body = body;
    error.retryAfter = respHeaders['retry-after'] || null;
    throw error;
  }

  return body;
}

/**
 * Make an authenticated API request with retry and exponential backoff.
 *
 * Retries on: 429 (rate limit), 500/502/503/504 (server errors),
 * and transient network errors (ECONNRESET, ETIMEDOUT, etc.).
 *
 * @param {string} endpoint - Path relative to API_BASE_URL
 * @param {object} [options]
 * @param {object} [options.params] - Query parameters
 * @param {object} [options.headers] - Additional headers
 * @param {string} [options.method] - HTTP method (default: GET)
 * @returns {Promise<object>} Parsed JSON response
 */
export async function apiRequest(endpoint, options = {}) {
  const { params = {}, headers = {}, method = 'GET' } = options;

  // Build URL with query params
  const url = new URL(endpoint, config.api.baseUrl);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }

  const requestHeaders = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    ...getAuthHeader(),
    ...headers,
  };

  const urlStr = url.toString();
  let lastError;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await executeRequest(urlStr, method, requestHeaders);
    } catch (err) {
      lastError = err;

      // Don't retry on non-retryable errors (400, 401, 403, 404, etc.)
      if (!isRetryable(err)) {
        break;
      }

      // Don't retry if we've exhausted attempts
      if (attempt >= MAX_RETRIES) {
        break;
      }

      const delay = retryDelay(attempt, err.retryAfter);
      const status = err.statusCode || err.code || 'unknown';
      console.warn(
        `[api] ${method} ${url.pathname} failed (${status}), ` +
        `retry ${attempt + 1}/${MAX_RETRIES} in ${Math.round(delay)}ms`
      );
      await sleep(delay);
    }
  }

  // Enhance error messages for common SSL/proxy issues
  if (lastError.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || lastError.code === 'CERT_HAS_EXPIRED') {
    console.error(
      `\n[api] SSL Certificate Error: ${lastError.code}\n` +
      '  Possible fixes:\n' +
      '  1. Set CA_CERT_PATH in .env to your corporate CA bundle\n' +
      '  2. Set STRICT_SSL=false in .env (insecure, for debugging only)\n'
    );
  } else if (lastError.code === 'ECONNREFUSED' || lastError.code === 'ENOTFOUND') {
    console.error(
      `\n[api] Connection Error: ${lastError.code} for ${urlStr}\n` +
      '  Possible fixes:\n' +
      '  1. Check API_BASE_URL in .env\n' +
      '  2. Configure HTTPS_PROXY if behind a corporate proxy\n'
    );
  }

  throw lastError;
}

/**
 * Close the dispatcher (cleanup).
 */
export async function closeClient() {
  if (_dispatcher) {
    await _dispatcher.close();
    _dispatcher = null;
  }
}
