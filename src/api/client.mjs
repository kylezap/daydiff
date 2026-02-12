import { Agent, ProxyAgent, request } from 'undici';
import { readFileSync } from 'fs';
import config from '../../config/default.mjs';

let _dispatcher = null;

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

/**
 * Make an authenticated API request.
 *
 * @param {string} endpoint - Path relative to API_BASE_URL (e.g. "/v1/users")
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

  const dispatcher = getDispatcher();

  try {
    const response = await request(url.toString(), {
      method,
      headers: requestHeaders,
      dispatcher,
    });

    const { statusCode } = response;
    const body = await response.body.json();

    if (statusCode < 200 || statusCode >= 300) {
      const error = new Error(`API request failed: ${statusCode} ${method} ${url.pathname}`);
      error.statusCode = statusCode;
      error.body = body;
      throw error;
    }

    return body;
  } catch (err) {
    // Enhance error messages for common SSL/proxy issues
    if (err.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || err.code === 'CERT_HAS_EXPIRED') {
      console.error(
        `\n[api] SSL Certificate Error: ${err.code}\n` +
        '  Possible fixes:\n' +
        '  1. Set CA_CERT_PATH in .env to your corporate CA bundle\n' +
        '  2. Set STRICT_SSL=false in .env (insecure, for debugging only)\n'
      );
    } else if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
      console.error(
        `\n[api] Connection Error: ${err.code} for ${url.toString()}\n` +
        '  Possible fixes:\n' +
        '  1. Check API_BASE_URL in .env\n' +
        '  2. Configure HTTPS_PROXY if behind a corporate proxy\n'
      );
    }
    throw err;
  }
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
