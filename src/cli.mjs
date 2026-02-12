#!/usr/bin/env node

import { Command } from 'commander';
import { fetchAllDatasets } from './api/fetcher.mjs';
import { diffAllDatasets } from './diff/engine.mjs';
import { closeDb, getDb } from './db/index.mjs';
import { closeClient } from './api/client.mjs';
import {
  listDatasets,
  listDiffs,
  getAvailableDates,
} from './db/queries.mjs';

const program = new Command();

program
  .name('daydiff')
  .description('Daily data diff reporter')
  .version('1.0.0');

// ─── fetch ───────────────────────────────────────────────────────

program
  .command('fetch')
  .description('Fetch today\'s datasets from the API and store snapshots')
  .option('-d, --date <date>', 'Override date (YYYY-MM-DD)', undefined)
  .action(async (opts) => {
    try {
      const results = await fetchAllDatasets(opts.date);
      const failed = results.filter(r => r.error);
      if (failed.length > 0) {
        process.exitCode = 1;
      }
    } catch (err) {
      console.error(`[fetch] Fatal error: ${err.message}`);
      process.exitCode = 1;
    } finally {
      await closeClient();
      closeDb();
    }
  });

// ─── diff ────────────────────────────────────────────────────────

program
  .command('diff')
  .description('Compute diff between today and previous day\'s snapshots')
  .option('-d, --date <date>', 'Override date (YYYY-MM-DD)', undefined)
  .action(async (opts) => {
    try {
      diffAllDatasets(opts.date);
    } catch (err) {
      console.error(`[diff] Fatal error: ${err.message}`);
      process.exitCode = 1;
    } finally {
      closeDb();
    }
  });

// ─── run ─────────────────────────────────────────────────────────

program
  .command('run')
  .description('Fetch datasets then compute diffs (daily job)')
  .option('-d, --date <date>', 'Override date (YYYY-MM-DD)', undefined)
  .action(async (opts) => {
    try {
      console.log('═══════════════════════════════════════════');
      console.log('  DayDiff — Daily Run');
      console.log('═══════════════════════════════════════════');

      const fetchResults = await fetchAllDatasets(opts.date);
      const fetchFailed = fetchResults.filter(r => r.error);

      diffAllDatasets(opts.date);

      if (fetchFailed.length > 0) {
        console.warn(`\n⚠  ${fetchFailed.length} dataset(s) had fetch errors`);
        process.exitCode = 1;
      }

      console.log('\n═══════════════════════════════════════════');
      console.log('  Run complete');
      console.log('═══════════════════════════════════════════\n');
    } catch (err) {
      console.error(`[run] Fatal error: ${err.message}`);
      process.exitCode = 1;
    } finally {
      await closeClient();
      closeDb();
    }
  });

// ─── dashboard ───────────────────────────────────────────────────

program
  .command('dashboard')
  .description('Start the dashboard web server')
  .option('-p, --port <port>', 'Port number', undefined)
  .action(async (opts) => {
    try {
      // Dynamic import to avoid loading Express unless needed
      const { startServer } = await import('./server/index.mjs');
      const port = opts.port ? parseInt(opts.port, 10) : undefined;
      await startServer(port);
    } catch (err) {
      console.error(`[dashboard] Fatal error: ${err.message}`);
      process.exitCode = 1;
    }
  });

// ─── status ──────────────────────────────────────────────────────

program
  .command('status')
  .description('Show latest fetch/diff summary')
  .action(() => {
    try {
      // Initialize DB
      getDb();

      const allDatasets = listDatasets();
      const dates = getAvailableDates();

      console.log('\n═══════════════════════════════════════════');
      console.log('  DayDiff — Status');
      console.log('═══════════════════════════════════════════\n');

      if (allDatasets.length === 0) {
        console.log('  No datasets have been fetched yet.');
        console.log('  Run: node src/cli.mjs fetch\n');
        return;
      }

      console.log(`  Datasets: ${allDatasets.length}`);
      for (const ds of allDatasets) {
        console.log(`    - ${ds.name} (key: ${ds.row_key})`);
      }

      console.log(`\n  Diff dates available: ${dates.length}`);
      if (dates.length > 0) {
        console.log(`  Latest: ${dates[0]}`);
        console.log(`  Oldest: ${dates[dates.length - 1]}`);
      }

      // Show latest diffs
      const recentDiffs = listDiffs(null, 10);
      if (recentDiffs.length > 0) {
        console.log('\n  Recent diffs:');
        for (const d of recentDiffs) {
          console.log(
            `    ${d.to_date} | ${d.dataset_name} | ` +
            `+${d.added_count} -${d.removed_count} ~${d.modified_count} =${d.unchanged_count}`
          );
        }
      }

      console.log('\n═══════════════════════════════════════════\n');
    } catch (err) {
      console.error(`[status] Error: ${err.message}`);
      process.exitCode = 1;
    } finally {
      closeDb();
    }
  });

// ─── install-schedule ────────────────────────────────────────────

program
  .command('install-schedule')
  .description('Install macOS launchd daily job')
  .action(async () => {
    try {
      const { installLaunchd } = await import('./scheduler/launchd.mjs');
      installLaunchd();
    } catch (err) {
      console.error(`[schedule] Error: ${err.message}`);
      process.exitCode = 1;
    }
  });

program.parse();
