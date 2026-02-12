import React from 'react';

const changeTypes = ['all', 'added', 'removed', 'modified'];

const typeColors = {
  all: '#58a6ff',
  added: '#3fb950',
  removed: '#f85149',
  modified: '#e3b341',
};

export default function FilterBar({
  datasets,
  selectedDataset,
  onDatasetChange,
  selectedChangeType,
  onChangeTypeChange,
  quickFilter,
  onQuickFilterChange,
}) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: '1rem',
      flexWrap: 'wrap',
      padding: '0.75rem 0',
    }}>
      {/* Dataset selector */}
      {datasets && datasets.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
          <label style={labelStyle}>Dataset:</label>
          <select
            value={selectedDataset || ''}
            onChange={(e) => onDatasetChange(e.target.value || null)}
            style={selectStyle}
          >
            <option value="">All datasets</option>
            {datasets.map((ds) => (
              <option key={ds.id} value={ds.id}>{ds.name}</option>
            ))}
          </select>
        </div>
      )}

      {/* Change type toggles */}
      <div style={{ display: 'flex', gap: '0.25rem' }}>
        {changeTypes.map((type) => (
          <button
            key={type}
            onClick={() => onChangeTypeChange(type === 'all' ? null : type)}
            style={{
              ...toggleStyle,
              background: (type === 'all' && !selectedChangeType) || selectedChangeType === type
                ? typeColors[type] + '22'
                : '#161b22',
              borderColor: (type === 'all' && !selectedChangeType) || selectedChangeType === type
                ? typeColors[type]
                : '#30363d',
              color: (type === 'all' && !selectedChangeType) || selectedChangeType === type
                ? typeColors[type]
                : '#8b949e',
            }}
          >
            {type.charAt(0).toUpperCase() + type.slice(1)}
          </button>
        ))}
      </div>

      {/* Quick filter search */}
      <div style={{ flex: 1, minWidth: 200 }}>
        <input
          type="text"
          placeholder="Quick filter... (search all columns)"
          value={quickFilter}
          onChange={(e) => onQuickFilterChange(e.target.value)}
          style={inputStyle}
        />
      </div>
    </div>
  );
}

const labelStyle = {
  color: '#8b949e',
  fontSize: '0.85rem',
  fontWeight: 500,
};

const selectStyle = {
  background: '#161b22',
  color: '#e1e4e8',
  border: '1px solid #30363d',
  borderRadius: 6,
  padding: '0.4rem 0.6rem',
  fontSize: '0.85rem',
  cursor: 'pointer',
  outline: 'none',
};

const toggleStyle = {
  border: '1px solid #30363d',
  borderRadius: 6,
  padding: '0.35rem 0.7rem',
  fontSize: '0.8rem',
  fontWeight: 500,
  cursor: 'pointer',
  transition: 'all 0.15s',
};

const inputStyle = {
  width: '100%',
  background: '#0d1117',
  color: '#e1e4e8',
  border: '1px solid #30363d',
  borderRadius: 6,
  padding: '0.4rem 0.75rem',
  fontSize: '0.85rem',
  outline: 'none',
};
