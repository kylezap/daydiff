import React from 'react';

const cardColors = {
  added: { bg: '#0d1f0d', border: '#238636', text: '#3fb950', icon: '+' },
  removed: { bg: '#1f0d0d', border: '#da3633', text: '#f85149', icon: '-' },
  modified: { bg: '#1f1a0d', border: '#d29922', text: '#e3b341', icon: '~' },
  unchanged: { bg: '#0d1117', border: '#30363d', text: '#8b949e', icon: '=' },
  total: { bg: '#0d1520', border: '#1f6feb', text: '#58a6ff', icon: '#' },
};

function Card({ label, value, type }) {
  const c = cardColors[type] || cardColors.unchanged;
  return (
    <div style={{
      background: c.bg,
      border: `1px solid ${c.border}`,
      borderRadius: 8,
      padding: '1rem 1.25rem',
      minWidth: 140,
      flex: '1 1 0',
    }}>
      <div style={{ color: '#8b949e', fontSize: '0.8rem', fontWeight: 500, marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
        {label}
      </div>
      <div style={{ color: c.text, fontSize: '1.75rem', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
        <span style={{ opacity: 0.5, marginRight: 2, fontSize: '1.1rem' }}>{c.icon}</span>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
    </div>
  );
}

export default function SummaryCards({ summary }) {
  if (!summary || summary.length === 0) {
    return <div style={{ color: '#8b949e', padding: '2rem 0' }}>No diff data available.</div>;
  }

  // Aggregate across all datasets for that date
  const totals = summary.reduce(
    (acc, s) => ({
      added: acc.added + (s.added_count || 0),
      removed: acc.removed + (s.removed_count || 0),
      modified: acc.modified + (s.modified_count || 0),
      unchanged: acc.unchanged + (s.unchanged_count || 0),
    }),
    { added: 0, removed: 0, modified: 0, unchanged: 0 }
  );

  const total = totals.added + totals.removed + totals.modified + totals.unchanged;

  return (
    <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
      <Card label="Total Rows" value={total} type="total" />
      <Card label="Added" value={totals.added} type="added" />
      <Card label="Removed" value={totals.removed} type="removed" />
      <Card label="Modified" value={totals.modified} type="modified" />
      <Card label="Unchanged" value={totals.unchanged} type="unchanged" />
    </div>
  );
}
