import { config as dotenvConfig } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, readFileSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(__dirname, '..');

// Load .env from project root
dotenvConfig({ path: resolve(ROOT_DIR, '.env') });

/**
 * Read a CA certificate bundle from disk if configured.
 * Returns the PEM contents as a string, or undefined.
 */
function loadCaCert() {
  const certPath = process.env.CA_CERT_PATH;
  if (!certPath) return undefined;
  const resolved = resolve(ROOT_DIR, certPath);
  if (!existsSync(resolved)) {
    console.warn(`[config] CA_CERT_PATH specified but file not found: ${resolved}`);
    return undefined;
  }
  return readFileSync(resolved, 'utf-8');
}

const config = {
  // Project root
  rootDir: ROOT_DIR,

  // Data directory for SQLite and logs
  dataDir: resolve(ROOT_DIR, 'data'),

  // API settings
  api: {
    baseUrl: process.env.API_BASE_URL || 'https://api.example.com',
    apiKey: process.env.API_KEY || '',
    authType: process.env.API_AUTH_TYPE || 'Bearer', // Bearer, Basic, ApiKey
  },

  // Proxy settings
  proxy: {
    httpsProxy: process.env.HTTPS_PROXY || process.env.https_proxy || '',
    httpProxy: process.env.HTTP_PROXY || process.env.http_proxy || '',
    noProxy: process.env.NO_PROXY || process.env.no_proxy || 'localhost,127.0.0.1',
  },

  // SSL / TLS
  ssl: {
    strict: process.env.STRICT_SSL !== 'false',
    caCert: loadCaCert(),
  },

  // Dashboard
  dashboard: {
    port: parseInt(process.env.DASHBOARD_PORT, 10) || 3000,
    host: '127.0.0.1', // localhost only — never expose externally
  },

  // Scheduling
  schedule: {
    hour: parseInt(process.env.SCHEDULE_HOUR, 10) || 6,
    minute: parseInt(process.env.SCHEDULE_MINUTE, 10) || 0,
  },

  // Data retention
  retention: {
    snapshotDays: parseInt(process.env.RETENTION_DAYS, 10) || 30,
  },

  // Executive report (LLM)
  report: {
    model: process.env.REPORT_MODEL || 'gpt-4o-mini',
    maxSamplePerType: parseInt(process.env.REPORT_MAX_SAMPLE, 10) || 5,
  },

  // Feature flags (dashboard UI)
  features: {
    qualityTab: process.env.QUALITY_TAB_ENABLED === 'true',
  },
};

export default config;
