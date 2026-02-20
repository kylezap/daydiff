import express from 'express';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import { exec } from 'child_process';
import config from '../../config/default.mjs';
import { getDb, closeDb } from '../db/index.mjs';
import { setupRoutes } from './routes.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Start the dashboard Express server.
 * Binds to localhost only for security.
 */
export async function startServer(portOverride) {
  const port = portOverride || config.dashboard.port;
  const host = config.dashboard.host;

  // Initialize DB
  getDb();

  const app = express();

  // JSON parsing
  app.use(express.json());

  // CORS headers for local development
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', `http://${host}:${port}`);
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    next();
  });

  // API routes
  setupRoutes(app);

  // Serve dashboard static files
  const dashboardDist = resolve(__dirname, '../../dashboard/dist');
  if (existsSync(dashboardDist)) {
    app.use(express.static(dashboardDist));
    // SPA fallback: serve index.html for any non-API route
    app.use((req, res, next) => {
      if (req.method === 'GET' && !req.path.startsWith('/api/')) {
        res.sendFile(resolve(dashboardDist, 'index.html'));
      } else {
        next();
      }
    });
  } else {
    app.get('/', (req, res) => {
      res.type('html').send(`
        <html>
          <body style="font-family: system-ui; padding: 2rem; max-width: 600px; margin: 0 auto;">
            <h1>DayDiff Dashboard</h1>
            <p>The dashboard has not been built yet. Run:</p>
            <pre style="background: #f0f0f0; padding: 1rem; border-radius: 4px;">cd dashboard && npm install && npm run build</pre>
            <p>Then restart the dashboard server.</p>
            <hr>
            <p>API is available at <a href="/api/datasets">/api/datasets</a></p>
          </body>
        </html>
      `);
    });
  }

  return new Promise((resolvePromise) => {
    const server = app.listen(port, host, () => {
      const url = `http://${host}:${port}`;
      console.log(`\n═══════════════════════════════════════════`);
      console.log(`  DayDiff Dashboard`);
      console.log(`  ${url}`);
      console.log(`  Press Ctrl+C to stop`);
      console.log(`═══════════════════════════════════════════\n`);

      // Open browser (skipped when DASHBOARD_SKIP_OPEN=1, e.g. npm run dev)
      if (process.env.DASHBOARD_SKIP_OPEN !== '1') {
        exec(`open ${url}`, (err) => {
          if (err) console.log(`  Open ${url} in your browser`);
        });
      }

      resolvePromise(server);
    });

    // Graceful shutdown
    const shutdown = () => {
      console.log('\n[dashboard] Shutting down...');
      server.close(() => {
        closeDb();
        process.exit(0);
      });
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
}
