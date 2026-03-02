import React, { useState, useEffect } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import { fetchDiffFieldChanges } from '../api/client.js';

const BAR_COLOR = '#e3b341';
const MAX_BARS = 25;
const LABEL_MAX = 40;

const tooltipStyle = {
  backgroundColor: '#161b22',
  border: '1px solid #30363d',
  borderRadius: 6,
  fontSize: '0.85rem',
};

function truncatePath(path) {
  if (!path || path.length <= LABEL_MAX) return path;
  return path.slice(0, LABEL_MAX - 3) + '...';
}

function FieldBarChart({ data, title, defaultShowAll }) {
  const [showAll, setShowAll] = useState(defaultShowAll);
  const displayData = showAll ? data : data.slice(0, MAX_BARS);
  const hasMore = data.length > MAX_BARS;

  if (!displayData || displayData.length === 0) return null;

  const chartData = displayData.map((r) => ({
    ...r,
    label: truncatePath(r.field_path),
  }));

  return (
    <div style={{ marginBottom: '1.5rem' }}>
      <h4 style={{ color: '#e1e4e8', fontSize: '0.95rem', marginBottom: '0.5rem', fontWeight: 600 }}>
        {title}
      </h4>
      <div style={{ width: '100%', height: Math.min(280, 24 * chartData.length + 60), minHeight: 120, minWidth: 0 }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={chartData}
            layout="vertical"
            margin={{ top: 4, right: 24, left: 8, bottom: 4 }}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="#21262d" horizontal={false} />
            <XAxis type="number" tick={{ fill: '#8b949e', fontSize: 11 }} />
            <YAxis
              type="category"
              dataKey="label"
              width={180}
              tick={{ fill: '#8b949e', fontSize: 11 }}
              tickLine={false}
            />
            <Tooltip
              contentStyle={tooltipStyle}
              formatter={(value) => [value, 'rows']}
              labelFormatter={(label, payload) => payload[0]?.payload?.field_path ?? label}
            />
            <Bar dataKey="change_count" fill={BAR_COLOR} radius={[0, 3, 3, 0]} name="Rows" />
          </BarChart>
        </ResponsiveContainer>
      </div>
      {hasMore && (
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          style={{
            marginTop: '0.25rem',
            background: 'none',
            border: 'none',
            color: '#58a6ff',
            fontSize: '0.8rem',
            cursor: 'pointer',
          }}
        >
          {showAll ? `Show top ${MAX_BARS} only` : `Show all ${data.length}`}
        </button>
      )}
    </div>
  );
}

export default function DiffFieldChangeChart({ diffId }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!diffId) {
      setData(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchDiffFieldChanges(diffId)
      .then((res) => {
        if (!cancelled) {
          setData(res);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err.message);
          setLoading(false);
        }
      });
    return () => { cancelled = true; };
  }, [diffId]);

  if (!diffId) return null;
  if (loading) {
    return (
      <div style={{ padding: '1rem', color: '#8b949e', fontSize: '0.9rem' }}>
        Loading field change breakdown...
      </div>
    );
  }
  if (error) {
    return (
      <div style={{ padding: '1rem', color: '#f85149', fontSize: '0.9rem' }}>
        {error}
      </div>
    );
  }
  const hasTop = data?.topLevel?.length > 0;
  const hasNested = data?.nested?.length > 0;
  if (!hasTop && !hasNested) {
    return (
      <div style={{ padding: '1rem', color: '#8b949e', fontSize: '0.9rem' }}>
        No field change data for this diff. Re-run the diff to generate counts.
      </div>
    );
  }

  return (
    <div
      style={{
        padding: '1rem',
        background: '#161b22',
        border: '1px solid #30363d',
        borderRadius: 6,
      }}
    >
      <FieldBarChart data={data.topLevel || []} title="Top-level fields" defaultShowAll={false} />
      <FieldBarChart data={data.nested || []} title="Nested paths (JSON)" defaultShowAll={false} />
    </div>
  );
}
