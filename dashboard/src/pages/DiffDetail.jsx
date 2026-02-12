import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import DiffGrid from '../components/DiffGrid.jsx';
import FilterBar from '../components/FilterBar.jsx';
import DatePicker from '../components/DatePicker.jsx';
import {
  fetchDates, fetchDiffs, fetchDiff, fetchDatasets,
} from '../api/client.js';

const TITLES = {
  platform: 'Platform Diff Detail',
  vulnerability: 'Vulnerability Diff Detail',
};

export default function DiffDetail({ category, basePath = '/platform' }) {
  const { id } = useParams();
  const navigate = useNavigate();

  const [dates, setDates] = useState([]);
  const [selectedDate, setSelectedDate] = useState(null);
  const [datasets, setDatasets] = useState([]);
  const [selectedDataset, setSelectedDataset] = useState(null);
  const [diffs, setDiffs] = useState([]);
  const [selectedDiffId, setSelectedDiffId] = useState(id ? parseInt(id, 10) : null);
  const [diff, setDiff] = useState(null);
  const [changeType, setChangeType] = useState(null);
  const [quickFilter, setQuickFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [gridTotal, setGridTotal] = useState(0);

  // Load initial data (scoped to category)
  useEffect(() => {
    async function load() {
      try {
        const [dateList, dsList] = await Promise.all([
          fetchDates(category),
          fetchDatasets(category),
        ]);
        setDates(dateList);
        setDatasets(dsList);
        if (!id && dateList.length > 0) {
          setSelectedDate(dateList[0]);
        }
      } catch (err) {
        console.error('Failed to load initial data:', err);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [id, category]);

  // If navigated with an ID, load that diff directly
  useEffect(() => {
    if (!id) return;
    async function loadDiff() {
      try {
        const d = await fetchDiff(id);
        setDiff(d);
        setSelectedDate(d.to_date);
        setSelectedDiffId(parseInt(id, 10));
      } catch (err) {
        console.error('Failed to load diff:', err);
      }
    }
    loadDiff();
  }, [id]);

  // Load diffs list when date or dataset changes (scoped to category)
  useEffect(() => {
    if (!selectedDate) return;
    async function loadDiffs() {
      try {
        const allDiffs = await fetchDiffs(selectedDataset, 90, category);
        const filtered = allDiffs.filter(d => d.to_date === selectedDate);
        setDiffs(filtered);

        // Auto-select first diff if none selected or current doesn't match
        if (filtered.length > 0) {
          const current = filtered.find(d => d.id === selectedDiffId);
          if (!current) {
            setSelectedDiffId(filtered[0].id);
          }
        }
      } catch (err) {
        console.error('Failed to load diffs:', err);
      }
    }
    loadDiffs();
  }, [selectedDate, selectedDataset, category]);

  // Load diff metadata when selected diff changes
  useEffect(() => {
    if (!selectedDiffId) return;
    async function loadDiff() {
      try {
        const d = await fetchDiff(selectedDiffId);
        setDiff(d);
      } catch (err) {
        console.error('Failed to load diff:', err);
      }
    }
    loadDiff();
  }, [selectedDiffId]);

  const handleDateChange = useCallback((date) => {
    setSelectedDate(date);
    setSelectedDiffId(null);
    navigate(`${basePath}/diff`, { replace: true });
  }, [navigate, basePath]);

  const handleDiffSelect = useCallback((diffId) => {
    setSelectedDiffId(diffId);
    navigate(`${basePath}/diff/${diffId}`, { replace: true });
  }, [navigate, basePath]);

  // Stable callback for grid total updates
  const handleTotalChange = useCallback((total) => {
    setGridTotal(total);
  }, []);

  if (loading) {
    return <div style={{ color: '#8b949e', padding: '2rem' }}>Loading...</div>;
  }

  if (dates.length === 0) {
    return (
      <div style={{ color: '#8b949e', textAlign: 'center', padding: '4rem 2rem' }}>
        <h2 style={{ color: '#e1e4e8', marginBottom: '0.5rem' }}>No Data Yet</h2>
        <p>Run a fetch and diff first, then come back here.</p>
      </div>
    );
  }

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
        <h2 style={{ color: '#e1e4e8', fontSize: '1.25rem', fontWeight: 600 }}>
          {TITLES[category] || 'Diff Detail'}
          {diff && (
            <span style={{ color: '#8b949e', fontWeight: 400, fontSize: '0.9rem', marginLeft: '0.75rem' }}>
              {diff.dataset_name} &mdash; {diff.from_date} &rarr; {diff.to_date}
            </span>
          )}
        </h2>
        <DatePicker dates={dates} selected={selectedDate} onChange={handleDateChange} />
      </div>

      {/* Diff selector tabs */}
      {diffs.length > 1 && (
        <div style={{ display: 'flex', gap: '0.25rem', marginBottom: '0.5rem', flexWrap: 'wrap' }}>
          {diffs.map((d) => (
            <button
              key={d.id}
              onClick={() => handleDiffSelect(d.id)}
              style={{
                background: d.id === selectedDiffId ? '#21262d' : '#0d1117',
                color: d.id === selectedDiffId ? '#e1e4e8' : '#8b949e',
                border: `1px solid ${d.id === selectedDiffId ? '#58a6ff' : '#30363d'}`,
                borderRadius: 6,
                padding: '0.35rem 0.75rem',
                fontSize: '0.8rem',
                cursor: 'pointer',
                fontWeight: d.id === selectedDiffId ? 600 : 400,
              }}
            >
              {d.dataset_name}
              <span style={{ marginLeft: 6, opacity: 0.6 }}>
                +{d.added_count} -{d.removed_count} ~{d.modified_count}
              </span>
            </button>
          ))}
        </div>
      )}

      {/* Summary strip */}
      {diff && (
        <div style={{
          display: 'flex',
          gap: '1.5rem',
          padding: '0.6rem 1rem',
          background: '#161b22',
          border: '1px solid #30363d',
          borderRadius: 6,
          marginBottom: '0.5rem',
          fontSize: '0.85rem',
        }}>
          <span style={{ color: '#3fb950' }}>+{diff.added_count} added</span>
          <span style={{ color: '#f85149' }}>-{diff.removed_count} removed</span>
          <span style={{ color: '#e3b341' }}>~{diff.modified_count} modified</span>
          <span style={{ color: '#8b949e' }}>={diff.unchanged_count} unchanged</span>
          <span style={{ color: '#8b949e', marginLeft: 'auto' }}>
            {gridTotal.toLocaleString()} matching items
          </span>
        </div>
      )}

      {/* Filter bar */}
      <FilterBar
        datasets={datasets}
        selectedDataset={selectedDataset}
        onDatasetChange={setSelectedDataset}
        selectedChangeType={changeType}
        onChangeTypeChange={setChangeType}
        quickFilter={quickFilter}
        onQuickFilterChange={setQuickFilter}
      />

      {/* AG Grid — server-side paginated */}
      <DiffGrid
        diffId={selectedDiffId}
        changeType={changeType}
        quickFilter={quickFilter}
        onTotalChange={handleTotalChange}
      />
    </div>
  );
}
