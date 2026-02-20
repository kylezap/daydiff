import React, { useEffect, useState } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import Sidebar from './components/Sidebar.jsx';
import Overview from './pages/Overview.jsx';
import DiffDetail from './pages/DiffDetail.jsx';
import Quality from './pages/Quality.jsx';
import Report from './pages/Report.jsx';
import { fetchConfig } from './api/client.js';

export default function App() {
  const [config, setConfig] = useState({ qualityTabEnabled: false });

  useEffect(() => {
    fetchConfig()
      .then(setConfig)
      .catch(() => setConfig({ qualityTabEnabled: false }));
  }, []);

  return (
    <div className="app-layout">
      <Sidebar qualityTabEnabled={config.qualityTabEnabled} />
      <main className="app-main">
        <Routes>
          {/* Redirect root to platform overview */}
          <Route path="/" element={<Navigate to="/platform" replace />} />

          {/* Platform views */}
          <Route path="/platform" element={<Overview category="platform" />} />
          <Route path="/platform/diff" element={<DiffDetail category="platform" basePath="/platform" />} />
          <Route path="/platform/diff/:id" element={<DiffDetail category="platform" basePath="/platform" />} />

          {/* Vulnerability views */}
          <Route path="/vulns" element={<Overview category="vulnerability" />} />
          <Route path="/vulns/diff" element={<DiffDetail category="vulnerability" basePath="/vulns" />} />
          <Route path="/vulns/diff/:id" element={<DiffDetail category="vulnerability" basePath="/vulns" />} />

          {/* Data Quality (feature-flagged) */}
          <Route
            path="/quality"
            element={
              config.qualityTabEnabled ? (
                <Quality />
              ) : (
                <Navigate to="/platform" replace />
              )
            }
          />

          {/* Executive Report */}
          <Route path="/report" element={<Report />} />
        </Routes>
      </main>

      <style>{`
        .app-layout {
          min-height: 100vh;
          display: flex;
        }
        .app-main {
          flex: 1;
          padding: 1.5rem;
          max-width: 1440px;
          width: 100%;
          overflow-x: auto;
        }
      `}</style>
    </div>
  );
}
