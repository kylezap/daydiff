import React from 'react';

export default function DatePicker({ dates, selected, onChange }) {
  if (!dates || dates.length === 0) {
    return <span style={{ color: '#8b949e', fontSize: '0.85rem' }}>No dates available</span>;
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
      <label style={{ color: '#8b949e', fontSize: '0.85rem', fontWeight: 500 }}>
        Date:
      </label>
      <select
        value={selected || ''}
        onChange={(e) => onChange(e.target.value)}
        style={{
          background: '#161b22',
          color: '#e1e4e8',
          border: '1px solid #30363d',
          borderRadius: 6,
          padding: '0.4rem 0.6rem',
          fontSize: '0.85rem',
          cursor: 'pointer',
          outline: 'none',
        }}
      >
        {dates.map((d) => (
          <option key={d} value={d}>{d}</option>
        ))}
      </select>
      <div style={{ display: 'flex', gap: '0.25rem' }}>
        <button
          onClick={() => {
            const idx = dates.indexOf(selected);
            if (idx < dates.length - 1) onChange(dates[idx + 1]);
          }}
          disabled={dates.indexOf(selected) >= dates.length - 1}
          style={btnStyle}
          title="Previous day"
        >
          &#9664;
        </button>
        <button
          onClick={() => {
            const idx = dates.indexOf(selected);
            if (idx > 0) onChange(dates[idx - 1]);
          }}
          disabled={dates.indexOf(selected) <= 0}
          style={btnStyle}
          title="Next day"
        >
          &#9654;
        </button>
      </div>
    </div>
  );
}

const btnStyle = {
  background: '#21262d',
  color: '#e1e4e8',
  border: '1px solid #30363d',
  borderRadius: 4,
  padding: '0.25rem 0.5rem',
  cursor: 'pointer',
  fontSize: '0.75rem',
  lineHeight: 1,
};
