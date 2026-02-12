import {
  listDatasets,
  listDiffs,
  getDiff,
  getDiffItems,
  getSummaryForDate,
  getTrend,
  getAvailableDates,
} from '../db/queries.mjs';

/**
 * Set up all API routes for the dashboard.
 */
export function setupRoutes(app) {

  // ─── GET /api/datasets ──────────────────────────────────────────
  app.get('/api/datasets', (req, res) => {
    try {
      const datasets = listDatasets();
      res.json({ data: datasets });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── GET /api/dates ─────────────────────────────────────────────
  app.get('/api/dates', (req, res) => {
    try {
      const dates = getAvailableDates();
      res.json({ data: dates });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── GET /api/diffs ─────────────────────────────────────────────
  app.get('/api/diffs', (req, res) => {
    try {
      const { dataset_id, limit } = req.query;
      const diffs = listDiffs(
        dataset_id ? parseInt(dataset_id, 10) : null,
        limit ? parseInt(limit, 10) : 90
      );
      res.json({ data: diffs });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── GET /api/diffs/:id ─────────────────────────────────────────
  app.get('/api/diffs/:id', (req, res) => {
    try {
      const diff = getDiff(parseInt(req.params.id, 10));
      if (!diff) {
        return res.status(404).json({ error: 'Diff not found' });
      }
      res.json({ data: diff });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── GET /api/diffs/:id/items ───────────────────────────────────
  app.get('/api/diffs/:id/items', (req, res) => {
    try {
      const { change_type } = req.query;
      const items = getDiffItems(
        parseInt(req.params.id, 10),
        change_type || null
      );

      // Parse JSON fields for the client
      const parsed = items.map(item => ({
        ...item,
        old_data: item.old_data ? JSON.parse(item.old_data) : null,
        new_data: item.new_data ? JSON.parse(item.new_data) : null,
        changed_fields: item.changed_fields ? JSON.parse(item.changed_fields) : null,
      }));

      res.json({ data: parsed });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── GET /api/summary ──────────────────────────────────────────
  app.get('/api/summary', (req, res) => {
    try {
      const { date } = req.query;
      if (!date) {
        // Default to most recent date
        const dates = getAvailableDates();
        if (dates.length === 0) {
          return res.json({ data: [], date: null });
        }
        const summary = getSummaryForDate(dates[0]);
        return res.json({ data: summary, date: dates[0] });
      }
      const summary = getSummaryForDate(date);
      res.json({ data: summary, date });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── GET /api/trend ─────────────────────────────────────────────
  app.get('/api/trend', (req, res) => {
    try {
      const { days, dataset_id } = req.query;
      const trend = getTrend(
        days ? parseInt(days, 10) : 30,
        dataset_id ? parseInt(dataset_id, 10) : null
      );
      res.json({ data: trend.reverse() }); // chronological order
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}
