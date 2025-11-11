import React, { useState, useEffect, useCallback, useRef } from 'react';
import BandwidthChart from './BandwidthChart';

const BandwidthDashboard = () => {
  const [charts, setCharts] = useState([]);
  const [loading, setLoading] = useState(false);
  const [proxyPort, setProxyPort] = useState('10220');
  
  // Store dates as Date objects for easier manipulation
  const [dateRange, setDateRange] = useState({
    start: new Date(Date.now() - 24 * 60 * 60 * 1000), // 24 hours ago
    end: new Date() // now
  });

  const initialLoadRef = useRef(true);

  // Format Date to local datetime string for input fields (YYYY-MM-DDTHH:mm)
  const formatDateForInput = (date) => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    
    return `${year}-${month}-${day}T${hours}:${minutes}`;
  };

  // Parse datetime string from input to Date object in local time
  const parseInputToDate = (datetimeString) => {
    return new Date(datetimeString);
  };

  const handleRefresh = () => {
    setCharts([]);
    loadCharts();
  };

  const loadCharts = useCallback(async () => {
    if (loading) return;

    setLoading(true);

    try {
      // Convert local Date objects to ISO strings - this preserves the local time
      // but indicates the timezone offset
      const startISO = dateRange.start ? dateRange.start.toISOString() : '';
      const endISO = dateRange.end ? dateRange.end.toISOString() : '';

      const params = new URLSearchParams();
      params.append('offset', '0');
      params.append('limit', '1000');
      if (startISO) params.append('start', startISO);
      if (endISO) params.append('end', endISO);
      if (proxyPort) params.append('proxyPort', proxyPort);

      const response = await fetch(`/api/bandwidth/ips?${params}`);

      if (!response.ok) {
        throw new Error(`Failed to fetch IP list (status ${response.status})`);
      }

      const responseData = await response.json();

      console.log('📡 Bandwidth IP response:', responseData);

      let ips = [];
      let ipMeta = {};

      if (responseData.success && Array.isArray(responseData.ips)) {
        ips = responseData.ips;
        ipMeta = responseData.ipDetails || {};
      } else if (responseData.success && Array.isArray(responseData.groups)) {
        const flattened = [];
        const meta = {};
        responseData.groups.forEach(group => {
          const label = group.label || group.key;
          (group.ips || []).forEach((item, index) => {
            flattened.push(item.ip);
            meta[item.ip] = {
              avgBandwidth: item.avgBandwidth || 0,
              measurementCount: item.measurementCount || 0,
              groupLabel: label,
              sortIndex: index
            };
          });
        });
        ips = flattened;
        ipMeta = meta;
      } else {
        throw new Error(responseData.error || 'Failed to fetch IP list');
      }

      console.log(`📊 Fetched ${ips.length} IPs, starting chart data requests...`);

      if (ips.length === 0) {
        console.log('⚠️ No IPs returned, stopping');
        setCharts([]);
        return;
      }

      const MAX_CONCURRENT = 8;
      const results = [];

      for (let i = 0; i < ips.length; i += MAX_CONCURRENT) {
        const batch = ips.slice(i, i + MAX_CONCURRENT);
        const batchResults = await Promise.all(batch.map(async (ip) => {
          const dataParams = new URLSearchParams({
            limit: '1400',
            start: startISO,
            end: endISO,
            proxyPort
          });

          try {
            const dataResponse = await fetch(`/api/bandwidth/data/${encodeURIComponent(ip)}?${dataParams}`, {
              cache: 'no-store'
            });

            if (!dataResponse.ok) {
              console.error(`Failed to fetch bandwidth data for ${ip}: ${dataResponse.status}`);
              return null;
            }

            const data = await dataResponse.json();

            const localTimeData = (data.success ? data.data : []).map(item => ({
              ...item,
              timestamp: new Date(item.timestamp).getTime()
            }));

            const details = ipMeta[ip] || {};

            return {
              key: ip,
              label: details.groupLabel ? `${ip} (${details.groupLabel})` : ip,
              data: localTimeData,
              loading: false,
              avgBandwidth: details.avgBandwidth || 0,
              measurementCount: details.measurementCount || 0,
              sortIndex: details.sortIndex ?? 0
            };
          } catch (err) {
            console.error(`Error fetching bandwidth data for ${ip}:`, err);
            return null;
          }
        }));

        results.push(...batchResults.filter(Boolean));
      }

      const newCharts = results
        .filter(Boolean)
        .sort((a, b) => {
          const diff = (b.avgBandwidth || 0) - (a.avgBandwidth || 0);
          if (diff !== 0) return diff;
          return (a.sortIndex || 0) - (b.sortIndex || 0);
        });
      console.log(`✅ Loaded ${newCharts.length} charts with data`, newCharts.map(c => ({ ip: c.key, dataPoints: c.data.length })));
      setCharts(newCharts);

    } catch (error) {
      console.error('❌ Error loading charts:', error);
      console.error('Error details:', {
        message: error.message,
        stack: error.stack
      });
    } finally {
      setLoading(false);
      initialLoadRef.current = false;
    }
  }, [loading, dateRange, proxyPort]);

  // Load initial charts
  useEffect(() => {
    if (initialLoadRef.current) {
      initialLoadRef.current = false;
      loadCharts();
    }
  }, [loadCharts]);

  // Simple DateTimeRangePicker Component
  const DateTimeRangePicker = ({ start, end, onChange }) => {
    const handleStartChange = (e) => {
      const newStart = parseInputToDate(e.target.value);
      onChange(newStart, end);
    };

    const handleEndChange = (e) => {
      const newEnd = parseInputToDate(e.target.value);
      onChange(start, newEnd);
    };

    return (
      <div className="date-range-picker">
        <label>
          From:
          <input
            type="datetime-local"
            value={formatDateForInput(start)} 
            onChange={handleStartChange}
          />
        </label>
        <label>
          To:
          <input
            type="datetime-local"
            value={formatDateForInput(end)} 
            onChange={handleEndChange} 
          />
        </label>
      </div>
    );
  };

  const handleDateRangeChange = (newStart, newEnd) => {
    setDateRange({ start: newStart, end: newEnd });
    
    // Reset and reload data
    setCharts([]);
    loadCharts();
  };

  return (
    <div className="bandwidth-dashboard">
      <header className="dashboard-header" style={{ position:'relative' }}>
        <h1>Bandwidth Monitoring</h1>
        <div style={{ position:'absolute', right:0, display:'flex', gap:10, alignItems:'center' }}>
          <DateTimeRangePicker
            start={dateRange.start}
            end={dateRange.end}
            onChange={handleDateRangeChange}
          />
          <select
            value={proxyPort}
            onChange={(e) => {
              const newPort = e.target.value;
              setProxyPort(newPort);
              setCharts([]);
              setTimeout(() => loadCharts(), 0);
            }}
            style={{ padding:'6px 10px' }}
          >
            <option value="10220">🇪🇸 Spain Digi Mobile (10220)</option>
            <option value="10041">🇬🇧 UK Virgin Media (10041)</option>
            <option value="10079">🇨🇦 CA-BE (10079)</option>
            <option value="10238">Italy & SPA (10238)</option>
            <option value="10038">🇵🇹 Portugal (10038)</option>
          </select>
          <button onClick={handleRefresh} className="refresh-btn" style={{ background:'none', border:'none', cursor:'pointer' }}>
            ✓
          </button>
        </div>
      </header>

      {/* Main content area with proper scrolling */}
      <div className="dashboard-content">
        <div className="charts-grid">
          {charts.map((chart, index) => (
            <div key={`${chart.key}-${index}`} className="chart-wrapper">
              <BandwidthChart
                title={chart.label}
                data={chart.data}
                isLoading={chart.loading}
                avgBandwidth={chart.avgBandwidth}
                subtitle={`${chart.measurementCount || 0} samples`}
              />
            </div>
          ))}
        </div>

        {loading && <div className="loading-more">Loading charts...</div>}

        {charts.length === 0 && !loading && (
          <div className="no-data">No bandwidth data available</div>
        )}
      </div>
    </div>
  );
};

export default BandwidthDashboard;