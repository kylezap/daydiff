import React, { useState, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import { fetchReport, fetchReportDates } from '../api/client.js';

const headerStyle = { color: '#e1e4e8', fontSize: '1.25rem', fontWeight: 600 };

export default function Report() {
  const [report, setReport] = useState(null);
  const [dates, setDates] = useState([]);
  const [selectedDate, setSelectedDate] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetchReportDates().then(setDates).catch(() => setDates([]));
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        setLoading(true);
        setError(null);
        const date = selectedDate || undefined;
        const data = await fetchReport(date);
        if (!cancelled) setReport(data);
      } catch (err) {
        if (!cancelled) {
          setReport(null);
          setError(err.message);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [selectedDate]);

  if (error && !loading) {
    return (
      <div style={{ minWidth: 0 }}>
        <h2 style={headerStyle}>Executive Report</h2>
        <div style={{ color: '#f85149', padding: '1rem 0' }}>
          <strong>Error:</strong> {error}
        </div>
        <div style={{ color: '#8b949e', fontSize: '0.9rem' }}>
          Reports are generated when the daily job runs with OPENAI_API_KEY set. Run{' '}
          <code style={{ background: '#21262d', padding: '0.2rem 0.4rem', borderRadius: 4 }}>
            node src/cli.mjs run
          </code>{' '}
          to generate.
        </div>
      </div>
    );
  }

  return (
    <div style={{ minWidth: 0 }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: '1.25rem',
          flexWrap: 'wrap',
          gap: '0.75rem',
        }}
      >
        <h2 style={headerStyle}>Executive Report</h2>
        <select
            value={selectedDate}
            onChange={(e) => setSelectedDate(e.target.value)}
            style={{
              background: '#21262d',
              border: '1px solid #30363d',
              color: '#e1e4e8',
              padding: '0.4rem 0.75rem',
              borderRadius: 6,
              fontSize: '0.9rem',
            }}
          >
            <option value="">Latest</option>
            {dates.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
      </div>

      {loading ? (
        <div style={{ color: '#8b949e', padding: '2rem' }}>Loading...</div>
      ) : report ? (
        <div
          className="report-content"
          style={{
            background: '#0d1117',
            border: '1px solid #30363d',
            borderRadius: 8,
            padding: '1.5rem',
            color: '#e1e4e8',
            lineHeight: 1.6,
          }}
        >
          <div style={{ fontSize: '0.8rem', color: '#8b949e', marginBottom: '1rem' }}>
            {report.report_date}
            {report.model_used && (
              <span style={{ marginLeft: '0.5rem' }}>· {report.model_used}</span>
            )}
          </div>
          <ReactMarkdown
            components={{
              h1: ({ children }) => (
                <h1 style={{ fontSize: '1.25rem', marginTop: '1.5rem', marginBottom: '0.5rem' }}>
                  {children}
                </h1>
              ),
              h2: ({ children }) => (
                <h2
                  style={{
                    fontSize: '1.1rem',
                    marginTop: '1.25rem',
                    marginBottom: '0.5rem',
                    color: '#58a6ff',
                  }}
                >
                  {children}
                </h2>
              ),
              h3: ({ children }) => (
                <h3 style={{ fontSize: '1rem', marginTop: '1rem', marginBottom: '0.4rem' }}>
                  {children}
                </h3>
              ),
              p: ({ children }) => (
                <p style={{ marginBottom: '0.75rem' }}>{children}</p>
              ),
              ul: ({ children }) => (
                <ul style={{ marginBottom: '0.75rem', paddingLeft: '1.5rem' }}>{children}</ul>
              ),
              li: ({ children }) => (
                <li style={{ marginBottom: '0.25rem' }}>{children}</li>
              ),
              strong: ({ children }) => (
                <strong style={{ color: '#f0f6fc', fontWeight: 600 }}>{children}</strong>
              ),
              code: ({ children }) => (
                <code
                  style={{
                    background: '#21262d',
                    padding: '0.1rem 0.35rem',
                    borderRadius: 4,
                    fontSize: '0.9em',
                  }}
                >
                  {children}
                </code>
              ),
            }}
          >
            {report.content}
          </ReactMarkdown>
        </div>
      ) : (
        <div style={{ color: '#8b949e', padding: '2rem' }}>
          No executive report found. Reports are generated when the daily job runs with
          OPENAI_API_KEY set.
        </div>
      )}
    </div>
  );
}
