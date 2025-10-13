import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';

const StatusTable = () => {
  const [statusData, setStatusData] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [columnCount, setColumnCount] = useState(30);

  // Use ref to always get the latest columnCount
  const columnCountRef = useRef(columnCount);

  // Backend URL
  const BACKEND_URL = 'http://162.247.153.49:5000/now-status';

  // Update ref when columnCount changes
  useEffect(() => {
    columnCountRef.current = columnCount;
  }, [columnCount]);

  // Function to fetch status data with Axios
  const fetchStatus = async () => {
    try {
      setLoading(true);
      const response = await axios.get(BACKEND_URL, {
        timeout: 120000, // 2 minute timeout for backend processing
        headers: {
          'Content-Type': 'application/json',
        }
      });
      
      const data = response.data;
      
      // Handle the backend response format
      // Backend returns: { status: "completed", count: X, results: [...] }
      if (data.results && Array.isArray(data.results)) {
        const results = data.results;
        
        setStatusData(prevData => {
          // Add timestamp to each result
          const timestampedData = results.map(item => ({
            ...item,
            timestamp: new Date(),
            id: Date.now() + Math.random()
          }));
          
          // For multiple rows, we need to handle each row separately
          if (prevData.length === 0) {
            // Initial data - create rows
            return timestampedData.map((row, index) => ({
              ...row,
              rowNumber: index + 1, // Add row number starting from 1
              history: [row] // Start history with current data
            }));
          } else {
            // Update existing rows with new data
            return prevData.map((existingRow, index) => {
              const newRowData = timestampedData[index];
              if (newRowData) {
                const newHistory = [...(existingRow.history || []), newRowData].slice(-columnCountRef.current);
                return {
                  ...existingRow,
                  ...newRowData,
                  rowNumber: index + 1, // Keep row number
                  history: newHistory
                };
              }
              return existingRow;
            });
          }
        });
        
        setError(null);
      } else {
        throw new Error('Invalid response format from server');
      }
      
    } catch (err) {
      console.error('Error fetching status:', err);
      
      if (err.code === 'ECONNREFUSED') {
        setError('Connection refused: Backend server is not running or not accessible');
      } else if (err.code === 'NETWORK_ERROR') {
        setError('Network error: Cannot connect to the backend server');
      } else if (err.response) {
        setError(`Server error: ${err.response.status} - ${err.response.statusText}`);
      } else if (err.request) {
        setError('No response from server: Backend might be processing request');
      } else if (err.message.includes('timeout')) {
        setError('Request timeout: Backend is taking too long to respond');
      } else {
        setError(`Error: ${err.message}`);
      }
    } finally {
      setLoading(false);
    }
  };

  // Initial fetch and set up interval (3 minutes = 180000 ms)
  useEffect(() => {
    fetchStatus(); // Initial fetch
    
    const interval = setInterval(fetchStatus, 180000); // Fetch every 3 minutes
    
    return () => clearInterval(interval); // Cleanup on unmount
  }, []);

  // Update data when column count changes
  useEffect(() => {
    setStatusData(prevData => 
      prevData.map(row => ({
        ...row,
        history: (row.history || []).slice(-columnCount)
      }))
    );
  }, [columnCount]);

  // Function to format time for header
  const formatHeaderTime = (timestamp) => {
    if (!timestamp) return '-';
    return timestamp.toLocaleTimeString('en-US', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  // Function to format RTT value to compact form
  const formatRTT = (rtt) => {
    if (!rtt) return '-';
    // Extract just the number part for compact display
    const match = rtt.match(/(\d+\.?\d*)/);
    return match ? match[1] : rtt;
  };

  // Function to check if RTT is high (> 1s)
  const isHighRTT = (rtt) => {
    if (!rtt) return false;
    const match = rtt.match(/(\d+\.?\d*)/);
    if (match) {
      const rttValue = parseFloat(match[1]);
      return rttValue > 1000; // Highlight if RTT > 1000ms (1s)
    }
    return false;
  };

  // Generate column headers (timestamps)
  const generateHeaders = () => {
    if (statusData.length === 0) {
      return <th colSpan={columnCount}>No data available</th>;
    }

    // Get the latest history from first row to generate headers
    const firstRowHistory = statusData[0]?.history || [];
    const emptySlots = Array(columnCount - firstRowHistory.length).fill(null);
    const displayHistory = [...firstRowHistory, ...emptySlots];

    return displayHistory.map((item, index) => {
      const isEmpty = item === null;
      
      return (
        <th 
          key={isEmpty ? `empty-${index}` : `header-${index}`} 
          className="time-header"
          title={isEmpty ? 'Waiting for data' : item.timestamp?.toLocaleTimeString()}
        >
          {isEmpty ? '...' : formatHeaderTime(item.timestamp)}
        </th>
      );
    });
  };

  // Generate table rows with target IPs and RTT history
  const generateTableRows = () => {
    return statusData.map((row, rowIndex) => {
      const history = row.history || [];
      const emptySlots = Array(columnCount - history.length).fill(null);
      const displayHistory = [...history, ...emptySlots];
      
      return (
        <tr key={row.target || rowIndex} className="data-row">
          {/* Row number column */}
          <td className="row-number-header">
            {row.rowNumber || rowIndex + 1}
          </td>
          
          {/* Row header with target IP */}
          <td className="target-header" title={`Target: ${row.target}\nProxy: ${row.proxy}\nStatus: ${row.status}`}>
            <div className="target-text">
              {row.target.split(':')[0]} {/* Show only IP, not port */}
            </div>
          </td>
          
          {/* RTT values for each column */}
          {displayHistory.map((item, colIndex) => {
            const isEmpty = item === null;
            const rttValue = formatRTT(isEmpty ? null : item.rtt);
            const isHigh = !isEmpty && isHighRTT(item.rtt);
            
            return (
              <td 
                key={isEmpty ? `empty-${rowIndex}-${colIndex}` : `cell-${rowIndex}-${colIndex}`}
                className={`rtt-cell ${isEmpty ? 'empty' : ''} ${isHigh ? 'high-rtt' : ''} status-${item?.status || 'empty'}`}
                title={isEmpty ? 'Waiting for data' : `RTT: ${item.rtt} | Status: ${item.status} | ${item.timestamp?.toLocaleTimeString()}`}
              >
                {rttValue}
              </td>
            );
          })}
        </tr>
      );
    });
  };

  // Calculate next refresh time
  const getNextRefreshTime = () => {
    const nextRefresh = new Date(Date.now() + 180000);
    return nextRefresh.toLocaleTimeString('en-US', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  return (
    <div className="table-container">
      <div className="table-header">
        <h2>RTT Monitor Dashboard</h2>
        <div className="controls">
          <div className="control-item">
            <label htmlFor="columnCount">Columns: </label>
            <select 
              id="columnCount"
              value={columnCount} 
              onChange={(e) => setColumnCount(Number(e.target.value))}
            >
              <option value={10}>10</option>
              <option value={20}>20</option>
              <option value={30}>30</option>
              <option value={50}>50</option>
              <option value={100}>100</option>
            </select>
          </div>
          
          <button onClick={fetchStatus} disabled={loading}>
            {loading ? 'Measuring...' : 'Send Packet'}
          </button>
          
          <span className="last-update">
            Auto-refresh: 3 min
            <br />
            Next: {getNextRefreshTime()}
            <br />
            Targets: {statusData.length}
          </span>
        </div>
      </div>

      {error && (
        <div className="error-message">
          <strong>Note:</strong> {error}
        </div>
      )}

      <div className="table-wrapper">
        <table className="compact-rtt-table">
          <thead>
            <tr>
              <th className="row-number-column-header">No</th>
              <th className="target-column-header">Target IP</th>
              {generateHeaders()}
            </tr>
          </thead>
          <tbody>
            {statusData.length > 0 ? generateTableRows() : (
              <tr>
                <td colSpan={columnCount + 2} className="no-data">
                  {loading ? 'Measuring network latency... This may take a while.' : 'No data available'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="table-info">
        <p>
          Displaying: {statusData.length} targets × {columnCount} time points
        </p>
      </div>
    </div>
  );
};

export default StatusTable;