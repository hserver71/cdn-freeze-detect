import React from 'react';
import StatusTable from './StatusTable';
import './App.css';

function App() {
  return (
    <div className="App">
      <header className="App-header">
        <h1>CDN Freeze Detect</h1>
        <p>Real-time monitoring of proxy server status</p>
      </header>
      <main>
        <StatusTable />
      </main>
    </div>
  );
}

export default App;