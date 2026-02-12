import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import SummaryCards from '../components/SummaryCards.jsx';
import { ChangeDistributionChart, TrendChart } from '../components/DiffChart.jsx';
import DatePicker from '../components/DatePicker.jsx';
import { fetchDates, fetchSummary, fetchTrend, fetchDiffs, fetchDatasets } from '../api/client.js';

const TITLES = {
  platform: 'Platform Overview',
  vulnerability: 'Vulnerability Overview',
};

export default function Overview({ category }) {
  const navigate = useNavigate();
  const basePath = category === 'vulnerability' ? '/vulns' : '/platform';

  const [dates, setDates] = useState([]);
  const [selectedDate, setSelectedDate] = useState(null);
  const [summary, setSummary] = useState([]);
  const [trend, setTrend] = useState([]);
  const [diffs, setDiffs] = useState([]);
  const [datasets, setDatasets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Load initial data (scoped to category)
  useEffect(() => {
    async function load() {
      try {
        setLoading(true);
        setError(null);
        const [dateList, ds] = await Promise.all([
          fetchDates(category),
          fetchDatasets(category),
        ]);
        setDates(dateList);
        setDatasets(ds);
        if (dateList.length > 0) {
          setSelectedDate(dateList[0]);
        } else {
          setSelectedDate(null);
          setSummary([]);
          setTrend([]);
          setDiffs([]);
        }
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [category]);

  // Load data for selected date (scoped to category)
  useEffect(() => {
    if (!selectedDate) return;
    async function loadDate() {
      try {
        const [summaryResult, trendData, diffList] = await Promise.all([
          fetchSummary(selectedDate, category),
          fetchTrend(30, null, category),
          fetchDiffs(null, 90, category),
        ]);
        setSummary(summaryResult.data || []);
        setTrend(trendData);
        setDiffs(diffList);
      } catch (err) {
        setError(err.message);
      }
    }
    loadDate();
  }, [selectedDate, category]);

  if (loading) {
    return <div style={{ color: '#8b949e', padding: '2rem' }}>Loading...</div>;
  }

  if (error) {
    return (
      <div style={{ color: '#f85149', padding: '2rem' }}>
        <strong>Error:</strong> {error}
      </div>
    );
  }

  if (dates.length === 0) {
    return (
      <div style={emptyState}>
        <h2 style={{ color: '#e1e4e8', marginBottom: '0.5rem' }}>No Data Yet</h2>
        <p>Run a fetch and diff first:</p>
        <pre style={codeBlock}>node src/cli.mjs run</pre>
        <p style={{ marginTop: '0.5rem' }}>Then refresh this page.</p>
      </div>
    );
  }

  return (
    <div>
      {/* Header row with date picker */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.25rem' }}>
        <h2 style={{ color: '#e1e4e8', fontSize: '1.25rem', fontWeight: 600 }}>
          {TITLES[category] || 'Overview'}
        </h2>
        <DatePicker dates={dates} selected={selectedDate} onChange={setSelectedDate} />
      </div>

      {/* Summary cards */}
      <SummaryCards summary={summary} />

      {/* Charts */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginTop: '1.5rem' }}>
        <div style={panelStyle}>
          <h3 style={panelTitle}>Change Distribution by Dataset</h3>
          {summary.length > 0
            ? <ChangeDistributionChart summary={summary} />
            : <div style={{ color: '#8b949e', padding: '2rem', textAlign: 'center' }}>No data for this date</div>
          }
        </div>
        <div style={panelStyle}>
          <h3 style={panelTitle}>Trend (Last 30 Days)</h3>
          {trend.length > 0
            ? <TrendChart trend={trend} />
            : <div style={{ color: '#8b949e', padding: '2rem', textAlign: 'center' }}>Not enough data for trend</div>
          }
        </div>
      </div>

      {/* Diff list for selected date */}
      <div style={{ ...panelStyle, marginTop: '1.5rem' }}>
        <h3 style={panelTitle}>Diffs for {selectedDate}</h3>
        {summary.length > 0 ? (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>Dataset</th>
                <th style={thStyle}>From</th>
                <th style={thStyle}>To</th>
                <th style={{ ...thStyle, color: '#3fb950' }}>Added</th>
                <th style={{ ...thStyle, color: '#f85149' }}>Removed</th>
                <th style={{ ...thStyle, color: '#e3b341' }}>Modified</th>
                <th style={{ ...thStyle, color: '#8b949e' }}>Unchanged</th>
                <th style={thStyle}></th>
              </tr>
            </thead>
            <tbody>
              {summary.map((s) => (
                <tr key={s.diff_id} style={trStyle}>
                  <td style={tdStyle}>{s.dataset_name}</td>
                  <td style={tdStyle}>{s.from_date}</td>
                  <td style={tdStyle}>{s.to_date}</td>
                  <td style={{ ...tdStyle, color: '#3fb950', fontVariantNumeric: 'tabular-nums' }}>+{s.added_count}</td>
                  <td style={{ ...tdStyle, color: '#f85149', fontVariantNumeric: 'tabular-nums' }}>-{s.removed_count}</td>
                  <td style={{ ...tdStyle, color: '#e3b341', fontVariantNumeric: 'tabular-nums' }}>~{s.modified_count}</td>
                  <td style={{ ...tdStyle, color: '#8b949e', fontVariantNumeric: 'tabular-nums' }}>{s.unchanged_count}</td>
                  <td style={tdStyle}>
                    <button
                      onClick={() => navigate(`${basePath}/diff/${s.diff_id}`)}
                      style={viewBtnStyle}
                    >
                      View Details
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div style={{ color: '#8b949e', padding: '1rem' }}>No diffs for this date.</div>
        )}
      </div>
    </div>
  );
}

const emptyState = {
  color: '#8b949e',
  textAlign: 'center',
  padding: '4rem 2rem',
};

const codeBlock = {
  background: '#161b22',
  border: '1px solid #30363d',
  borderRadius: 6,
  padding: '0.75rem 1rem',
  fontFamily: 'SF Mono, Monaco, Consolas, monospace',
  fontSize: '0.85rem',
  display: 'inline-block',
  marginTop: '0.5rem',
  color: '#e1e4e8',
};

const panelStyle = {
  background: '#161b22',
  border: '1px solid #30363d',
  borderRadius: 8,
  padding: '1rem 1.25rem',
};

const panelTitle = {
  color: '#e1e4e8',
  fontSize: '0.95rem',
  fontWeight: 600,
  marginBottom: '0.75rem',
};

const tableStyle = {
  width: '100%',
  borderCollapse: 'collapse',
  fontSize: '0.85rem',
};

const thStyle = {
  textAlign: 'left',
  padding: '0.5rem 0.75rem',
  borderBottom: '1px solid #30363d',
  color: '#8b949e',
  fontWeight: 600,
  fontSize: '0.8rem',
  textTransform: 'uppercase',
  letterSpacing: '0.3px',
};

const tdStyle = {
  padding: '0.5rem 0.75rem',
  borderBottom: '1px solid #21262d',
  color: '#e1e4e8',
};

const trStyle = {
  transition: 'background 0.1s',
};

const viewBtnStyle = {
  background: '#21262d',
  color: '#58a6ff',
  border: '1px solid #30363d',
  borderRadius: 6,
  padding: '0.3rem 0.75rem',
  fontSize: '0.8rem',
  cursor: 'pointer',
  fontWeight: 500,
};
