import React from 'react';
import { Routes, Route, NavLink } from 'react-router-dom';
import Overview from './pages/Overview.jsx';
import DiffDetail from './pages/DiffDetail.jsx';

const navLinkClass = ({ isActive }) =>
  `nav-link ${isActive ? 'active' : ''}`;

export default function App() {
  return (
    <div className="app">
      <header className="app-header">
        <div className="header-left">
          <h1 className="logo">DayDiff</h1>
          <nav className="nav">
            <NavLink to="/" end className={navLinkClass}>Overview</NavLink>
            <NavLink to="/diff" className={navLinkClass}>Diff Detail</NavLink>
          </nav>
        </div>
      </header>
      <main className="app-main">
        <Routes>
          <Route path="/" element={<Overview />} />
          <Route path="/diff" element={<DiffDetail />} />
          <Route path="/diff/:id" element={<DiffDetail />} />
        </Routes>
      </main>

      <style>{`
        .app {
          min-height: 100vh;
          display: flex;
          flex-direction: column;
        }
        .app-header {
          background: #161b22;
          border-bottom: 1px solid #30363d;
          padding: 0 1.5rem;
          height: 52px;
          display: flex;
          align-items: center;
          position: sticky;
          top: 0;
          z-index: 100;
        }
        .header-left {
          display: flex;
          align-items: center;
          gap: 2rem;
        }
        .logo {
          font-size: 1.15rem;
          font-weight: 700;
          color: #58a6ff;
          letter-spacing: -0.5px;
        }
        .nav {
          display: flex;
          gap: 0.25rem;
        }
        .nav-link {
          color: #8b949e;
          text-decoration: none;
          padding: 0.4rem 0.75rem;
          border-radius: 6px;
          font-size: 0.9rem;
          font-weight: 500;
          transition: all 0.15s;
        }
        .nav-link:hover {
          color: #e1e4e8;
          background: #21262d;
        }
        .nav-link.active {
          color: #f0f6fc;
          background: #30363d;
        }
        .app-main {
          flex: 1;
          padding: 1.5rem;
          max-width: 1440px;
          width: 100%;
          margin: 0 auto;
        }
      `}</style>
    </div>
  );
}
