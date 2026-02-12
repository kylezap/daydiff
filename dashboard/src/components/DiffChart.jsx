import React from 'react';
import {
  BarChart, Bar, LineChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer,
} from 'recharts';

const COLORS = {
  added: '#3fb950',
  removed: '#f85149',
  modified: '#e3b341',
};

const tooltipStyle = {
  backgroundColor: '#161b22',
  border: '1px solid #30363d',
  borderRadius: 6,
  fontSize: '0.85rem',
};

export function ChangeDistributionChart({ summary }) {
  if (!summary || summary.length === 0) return null;

  const data = summary.map(s => ({
    name: s.dataset_name,
    Added: s.added_count,
    Removed: s.removed_count,
    Modified: s.modified_count,
  }));

  return (
    <div style={{ width: '100%', height: 280 }}>
      <ResponsiveContainer>
        <BarChart data={data} margin={{ top: 10, right: 20, left: 0, bottom: 5 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#21262d" />
          <XAxis dataKey="name" tick={{ fill: '#8b949e', fontSize: 12 }} />
          <YAxis tick={{ fill: '#8b949e', fontSize: 12 }} />
          <Tooltip contentStyle={tooltipStyle} />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Bar dataKey="Added" fill={COLORS.added} radius={[3, 3, 0, 0]} />
          <Bar dataKey="Removed" fill={COLORS.removed} radius={[3, 3, 0, 0]} />
          <Bar dataKey="Modified" fill={COLORS.modified} radius={[3, 3, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function TrendChart({ trend }) {
  if (!trend || trend.length === 0) return null;

  const data = trend.map(t => ({
    date: t.to_date,
    Added: t.added_count,
    Removed: t.removed_count,
    Modified: t.modified_count,
  }));

  return (
    <div style={{ width: '100%', height: 280 }}>
      <ResponsiveContainer>
        <LineChart data={data} margin={{ top: 10, right: 20, left: 0, bottom: 5 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#21262d" />
          <XAxis dataKey="date" tick={{ fill: '#8b949e', fontSize: 11 }} />
          <YAxis tick={{ fill: '#8b949e', fontSize: 12 }} />
          <Tooltip contentStyle={tooltipStyle} />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Line type="monotone" dataKey="Added" stroke={COLORS.added} strokeWidth={2} dot={{ r: 3 }} />
          <Line type="monotone" dataKey="Removed" stroke={COLORS.removed} strokeWidth={2} dot={{ r: 3 }} />
          <Line type="monotone" dataKey="Modified" stroke={COLORS.modified} strokeWidth={2} dot={{ r: 3 }} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
