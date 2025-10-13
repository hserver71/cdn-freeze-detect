import React from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import StatusTable from './components/StatusTable';
import './App.css';

// Placeholder component for History page
const History = () => {
  return (
    <div className="table-container">
      <div className="table-header">
        <h2>History Dashboard</h2>
        <p>History page - Coming soon</p>
      </div>
    </div>
  );
};

// Navigation Component
const Navigation = () => {
  return (
    <nav className="side-nav">
      <div className="nav-header">
        <h3>Menu</h3>
      </div>
      <ul className="nav-links">
        <li>
          <a href="/dashboard" className="nav-link">
            <span className="nav-icon">📊</span>
            Dashboard
          </a>
        </li>
        <li>
          <a href="/history" className="nav-link">
            <span className="nav-icon">📈</span>
            History
          </a>
        </li>
      </ul>
    </nav>
  );
};

// Main layout component
const Layout = ({ children }) => {
  return (
    <div className="App">
      <header className="App-header">
        <h1>Network Monitor</h1>
        <p>Real-time network latency monitoring</p>
      </header>
      <div className="main-content">
        <Navigation />
        <main className="content-area">
          {children}
        </main>
      </div>
    </div>
  );
};

function App() {
  return (
    <Router>
      <Routes>
        <Route path="/" element={<Layout><Navigate to="/dashboard" replace /></Layout>} />
        <Route path="/dashboard" element={<Layout><StatusTable /></Layout>} />
        <Route path="/history" element={<Layout><History /></Layout>} />
        <Route path="*" element={<Layout><div className="not-found">Page not found</div></Layout>} />
      </Routes>
    </Router>
  );
}

export default App;