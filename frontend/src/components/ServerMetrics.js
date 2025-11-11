import React, { useState, useEffect, useCallback, useMemo } from 'react';
import axios from 'axios';
import { Line } from 'react-chartjs-2';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
  TimeScale
} from 'chart.js';
import 'chartjs-adapter-date-fns';
import { format } from 'date-fns';

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
  TimeScale
);

const MASTER_COLOR = '#E74C3C';
const SLAVE_COLOR = '#3498DB';
const SERVER_COLORS = [
  '#36A2EB',
  '#FF6384',
  '#4BC0C0',
  '#FF9F40',
  '#9966FF',
  '#FFCD56',
  '#2ECC71',
  '#9B59B6',
  '#E67E22',
  '#1ABC9C',
  '#E74C3C',
  '#3498DB'
];

const GAP_THRESHOLD_MS = 2 * 60 * 1000; // 2 minutes

const withAlpha = (hexColor, alpha = 0.2) => {
  if (!hexColor) return hexColor;
  if (alpha >= 1) return hexColor;
  const hex = hexColor.replace('#', '');
  const bigint = parseInt(hex, 16);
  const r = (bigint >> 16) & 255;
  const g = (bigint >> 8) & 255;
  const b = bigint & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
};

const createDatasetConfig = (label, color, points, extraOptions = {}) => ({
  label,
  data: points,
  borderColor: color,
  backgroundColor: withAlpha(color, 0.25),
  fill: false,
  tension: 0.3,
  pointRadius: 0,
  pointHoverRadius: 4,
  spanGaps: true,
  segment: {
    borderColor: (ctx) => {
      const prev = ctx.p0?.parsed?.x;
      const curr = ctx.p1?.parsed?.x;
      if (!prev || !curr) return color;
      return (curr - prev) > GAP_THRESHOLD_MS ? '#000000' : color;
    }
  },
  ...extraOptions
});

// Helper function to determine server type based on server name
const getServerType = (serverName) => {
  const name = serverName.toLowerCase();
  
  // PowerDNS servers - start with NS- or contain 'ns' or 'dns' (but not 'host-palace')
  if (name.startsWith('ns-') || (name.includes('ns') && !name.includes('host-palace')) || name.includes('dns') || name.includes('nameserver')) {
    return 'powerdns';
  }
  
  // Nginx servers - host-palace servers, monitor, nginx, loadbalancer, lb, web
  if (name.includes('host-palace') || name.includes('monitor') || name.includes('nginx') || name.includes('loadbalancer') || name.includes('lb') || name.includes('web')) {
    return 'nginx';
  }
  
  // MySQL servers - contain 'master', 'slave', 'mysql', 'db', or 'database' (but not 'host-palace')
  if ((name.includes('master') || name.includes('slave') || name.includes('mysql') || name.includes('db') || name.includes('database')) && !name.includes('host-palace')) {
    return 'mysql';
  }
  
  // Default to nginx if unclear
  return 'nginx';
};

const ServerMetrics = () => {
  const [metricsData, setMetricsData] = useState([]);
  const [loading, setLoading] = useState(false);
  const [timeRange, setTimeRange] = useState({
    start: new Date(Date.now() - 24 * 60 * 60 * 1000), // 24 hours ago
    end: new Date()
  });
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [refreshInterval] = useState(60); // 60 seconds

  const metricsByServer = useMemo(() => {
    const grouped = new Map();
    metricsData.forEach(metric => {
      if (!grouped.has(metric.server)) {
        grouped.set(metric.server, []);
      }
      grouped.get(metric.server).push(metric);
    });

    grouped.forEach(entries => {
      entries.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    });

    return grouped;
  }, [metricsData]);

  const serverList = useMemo(() => Array.from(metricsByServer.keys()).sort(), [metricsByServer]);

  const serverTypeMap = useMemo(() => {
    const map = new Map();
    serverList.forEach(server => {
      map.set(server, getServerType(server));
    });
    return map;
  }, [serverList]);

  const serverColorMap = useMemo(() => {
    const map = new Map();
    serverList.forEach((server, index) => {
      map.set(server, SERVER_COLORS[index % SERVER_COLORS.length]);
    });
    return map;
  }, [serverList]);

  const getColorForServer = useCallback((server, alpha = 1) => {
    const lower = server.toLowerCase();
    let baseColor;
    if (lower.includes('master')) {
      baseColor = MASTER_COLOR;
    } else if (lower.includes('slave')) {
      baseColor = SLAVE_COLOR;
    } else {
      baseColor = serverColorMap.get(server) || '#888888';
    }
    return alpha >= 1 ? baseColor : withAlpha(baseColor, alpha);
  }, [serverColorMap]);

  const uniqueServerCount = serverList.length;

  const buildPoints = useCallback((metrics, selector) => {
    return metrics.map(metric => {
      const value = selector(metric);
      if (value === undefined || value === null || Number.isNaN(value)) {
        return { x: new Date(metric.timestamp).getTime(), y: null };
      }
      return {
        x: new Date(metric.timestamp).getTime(),
        y: Number(value)
      };
    });
  }, []);

  const hasData = (points) => points.some(point => point.y !== null);

  const nginxRequestDatasets = useMemo(() => {
    return serverList
      .filter(server => serverTypeMap.get(server) === 'nginx')
      .map(server => {
        const metrics = metricsByServer.get(server) || [];
        const points = buildPoints(metrics, metric => metric.nginx_request_count_per_min ?? null);
        if (!hasData(points)) {
          return null;
        }
        return createDatasetConfig(`${server} Requests`, getColorForServer(server), points);
      })
      .filter(Boolean);
  }, [serverList, serverTypeMap, metricsByServer, buildPoints, getColorForServer]);

  const pdnsRequestDatasets = useMemo(() => {
    return serverList
      .filter(server => serverTypeMap.get(server) === 'powerdns')
      .map(server => {
        const metrics = metricsByServer.get(server) || [];
        const points = buildPoints(metrics, metric => metric.nginx_request_count_per_min ?? null);
        if (!hasData(points)) {
          return null;
        }
        return createDatasetConfig(`${server} Requests`, getColorForServer(server), points);
      })
      .filter(Boolean);
  }, [serverList, serverTypeMap, metricsByServer, buildPoints, getColorForServer]);

  const cpuRamDatasets = useMemo(() => {
    const datasets = [];
    serverList.forEach(server => {
      const metrics = metricsByServer.get(server) || [];
      const cpuPoints = buildPoints(metrics, metric => metric.cpu_usage ?? null);
      if (hasData(cpuPoints)) {
        datasets.push(createDatasetConfig(`${server} CPU`, getColorForServer(server), cpuPoints));
      }

      const memPoints = buildPoints(metrics, metric => metric.mem_usage ?? null);
      if (hasData(memPoints)) {
        datasets.push(createDatasetConfig(`${server} RAM`, getColorForServer(server, 0.6), memPoints, {
          borderDash: [6, 4]
        }));
      }
    });
    return datasets;
  }, [serverList, metricsByServer, buildPoints, getColorForServer]);

  const diskOthersDatasets = useMemo(() => {
    const datasets = [];
    serverList.forEach(server => {
      if (serverTypeMap.get(server) === 'mysql') {
        return;
      }
      const metrics = metricsByServer.get(server) || [];
      const readPoints = buildPoints(metrics, metric => metric.disk_read_mb_per_min ?? null);
      if (hasData(readPoints)) {
        datasets.push(createDatasetConfig(`${server} Read`, getColorForServer(server), readPoints));
      }
      const writePoints = buildPoints(metrics, metric => metric.disk_write_mb_per_min ?? null);
      if (hasData(writePoints)) {
        datasets.push(createDatasetConfig(`${server} Write`, getColorForServer(server, 0.6), writePoints, {
          borderDash: [6, 4]
        }));
      }
    });
    return datasets;
  }, [serverList, serverTypeMap, metricsByServer, buildPoints, getColorForServer]);

  const diskMysqlDatasets = useMemo(() => {
    const datasets = [];
    serverList.forEach(server => {
      if (serverTypeMap.get(server) !== 'mysql') {
        return;
      }
      const metrics = metricsByServer.get(server) || [];
      const readPoints = buildPoints(metrics, metric => metric.disk_read_mb_per_min ?? null);
      if (hasData(readPoints)) {
        datasets.push(createDatasetConfig(`${server} Read`, getColorForServer(server), readPoints));
      }
      const writePoints = buildPoints(metrics, metric => metric.disk_write_mb_per_min ?? null);
      if (hasData(writePoints)) {
        datasets.push(createDatasetConfig(`${server} Write`, getColorForServer(server, 0.6), writePoints, {
          borderDash: [6, 4]
        }));
      }
    });
    return datasets;
  }, [serverList, serverTypeMap, metricsByServer, buildPoints, getColorForServer]);

  // Format Date for input field
  const formatDateForInput = (date) => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${year}-${month}-${day}T${hours}:${minutes}`;
  };

  // Parse input to Date
  const parseInputToDate = (datetimeString) => {
    return new Date(datetimeString);
  };

  // Fetch metrics data for ALL servers
  const fetchMetrics = useCallback(async () => {
    setLoading(true);
    try {
      const startTime = Math.floor(timeRange.start.getTime() / 1000);
      const endTime = Math.floor(timeRange.end.getTime() / 1000);

      // Fetch all servers' data (no server filter)
      const metricsResponse = await axios.get(`/api/metrics`, {
        params: {
          startTime,
          endTime,
          limit: 5000  // Higher limit to get enough data points for all servers
        }
      });

      if (metricsResponse.data.success) {
        // Sort by timestamp ascending for charts
        const sortedData = [...metricsResponse.data.data].sort((a, b) => 
          new Date(a.timestamp) - new Date(b.timestamp)
        );
        setMetricsData(sortedData);
      }
    } catch (error) {
      console.error('Error fetching metrics:', error);
    } finally {
      setLoading(false);
    }
  }, [timeRange]);

  // Initial load
  useEffect(() => {
    fetchMetrics();
  }, [fetchMetrics]);

  // Fetch metrics when time range changes
  useEffect(() => {
    fetchMetrics();
  }, [timeRange, fetchMetrics]);

  // Auto-refresh
  useEffect(() => {
    if (!autoRefresh) return;

    const interval = setInterval(() => {
      fetchMetrics();
    }, refreshInterval * 1000);

    return () => clearInterval(interval);
  }, [autoRefresh, refreshInterval, fetchMetrics]);

  const nginxRequestChartData = useMemo(() => ({ datasets: nginxRequestDatasets }), [nginxRequestDatasets]);

  const pdnsRequestChartData = useMemo(() => ({ datasets: pdnsRequestDatasets }), [pdnsRequestDatasets]);

  const cpuRamChartData = useMemo(() => ({ datasets: cpuRamDatasets }), [cpuRamDatasets]);

  const diskOthersChartData = useMemo(() => ({ datasets: diskOthersDatasets }), [diskOthersDatasets]);

  const diskMysqlChartData = useMemo(() => ({ datasets: diskMysqlDatasets }), [diskMysqlDatasets]);

  const chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: {
      mode: 'index',
      intersect: false,
    },
    plugins: {
      legend: {
        display: true,
        position: 'top',
        labels: {
          boxWidth: 12,
          padding: 8,
          font: {
            size: 11
          }
        }
      },
      tooltip: {
        enabled: true,
        itemSort: (a, b) => {
          const aValue = a.parsed?.y ?? -Infinity;
          const bValue = b.parsed?.y ?? -Infinity;
          return bValue - aValue;
        },
        callbacks: {
          title: (context) => {
            return format(new Date(context[0].parsed.x), 'yyyy-MM-dd HH:mm:ss');
          }
        }
      }
    },
    scales: {
      x: {
        type: 'time',
        time: {
          displayFormats: {
            hour: 'HH:mm',
            minute: 'HH:mm'
          }
        },
        title: {
          display: true,
          text: 'Time'
        }
      },
      y: {
        beginAtZero: true,
        title: {
          display: true,
          text: 'Value'
        }
      }
    }
  };

  // Format timestamp for display
  const formatTimestamp = (timestamp) => {
    return format(new Date(timestamp), 'yyyy-MM-dd HH:mm:ss');
  };

  return (
    <div className="server-metrics-container" style={{ padding: '20px', overflowY: 'auto', height: '100vh' }}>
      <div style={{ marginBottom: '20px' }}>
        <h2 style={{ marginBottom: '20px' }}>📊 Server Metrics - All Servers</h2>
        
        {/* Controls */}
        <div style={{ 
          display: 'flex', 
          gap: '15px', 
          flexWrap: 'wrap', 
          marginBottom: '20px',
          alignItems: 'center'
        }}>
          <div>
            <label style={{ marginRight: '5px' }}>Start:</label>
            <input
              type="datetime-local"
              value={formatDateForInput(timeRange.start)}
              onChange={(e) => setTimeRange(prev => ({ ...prev, start: parseInputToDate(e.target.value) }))}
              style={{ padding: '5px' }}
            />
          </div>

          <div>
            <label style={{ marginRight: '5px' }}>End:</label>
            <input
              type="datetime-local"
              value={formatDateForInput(timeRange.end)}
              onChange={(e) => setTimeRange(prev => ({ ...prev, end: parseInputToDate(e.target.value) }))}
              style={{ padding: '5px' }}
            />
          </div>

          <button onClick={fetchMetrics} disabled={loading} style={{ padding: '5px 15px' }}>
            🔄 Refresh
          </button>

          <div>
            <label style={{ marginRight: '5px' }}>
              <input
                type="checkbox"
                checked={autoRefresh}
                onChange={(e) => setAutoRefresh(e.target.checked)}
                style={{ marginRight: '5px' }}
              />
              Auto-refresh ({refreshInterval}s)
            </label>
          </div>

          <div style={{ fontSize: '14px', color: '#666' }}>
            <strong>Servers:</strong> {uniqueServerCount} | <strong>Total Records:</strong> {metricsData.length}
          </div>
        </div>
      </div>

      {loading && <div style={{ textAlign: 'center', padding: '20px' }}>Loading...</div>}

      {!loading && metricsData.length === 0 && (
        <div style={{ textAlign: 'center', padding: '20px' }}>No metrics data available for the selected time range</div>
      )}

      {!loading && metricsData.length > 0 && (
        <>
          {/* Charts - Full Width Vertical Stack */}
          <div style={{ 
            display: 'flex',
            flexDirection: 'column',
            gap: '20px',
            marginBottom: '30px'
          }}>
            {/* Nginx Requests Chart - Full Width (Show First) */}
            <div style={{ 
              width: '100%',
              backgroundColor: 'white', 
              padding: '20px', 
              borderRadius: '5px', 
              boxShadow: '0 2px 4px rgba(0,0,0,0.1)' 
            }}>
              <h3 style={{ marginTop: 0, marginBottom: '15px' }}>Nginx Requests (per min)</h3>
              <div style={{ height: '350px' }}>
                {nginxRequestChartData.datasets.length > 0 ? (
                  <Line data={nginxRequestChartData} options={chartOptions} />
                ) : (
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#666' }}>
                    No Nginx request data available
                  </div>
                )}
              </div>
            </div>

            {/* PDNS Requests Chart */}
            <div style={{ 
              width: '100%',
              backgroundColor: 'white', 
              padding: '20px', 
              borderRadius: '5px', 
              boxShadow: '0 2px 4px rgba(0,0,0,0.1)' 
            }}>
              <h3 style={{ marginTop: 0, marginBottom: '15px' }}>PDNS Requests (per min)</h3>
              <div style={{ height: '350px' }}>
                {pdnsRequestChartData.datasets.length > 0 ? (
                  <Line data={pdnsRequestChartData} options={chartOptions} />
                ) : (
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#666' }}>
                    No PDNS request data available
                  </div>
                )}
              </div>
            </div>

            {/* CPU & RAM Usage Chart */}
            <div style={{ 
              width: '100%',
              backgroundColor: 'white', 
              padding: '20px', 
              borderRadius: '5px', 
              boxShadow: '0 2px 4px rgba(0,0,0,0.1)' 
            }}>
              <h3 style={{ marginTop: 0, marginBottom: '15px' }}>CPU & RAM Usage (%)</h3>
              <div style={{ height: '350px' }}>
                {cpuRamChartData.datasets.length > 0 ? (
                  <Line 
                    data={cpuRamChartData}
                    options={{
                      ...chartOptions,
                      scales: {
                        ...chartOptions.scales,
                        y: {
                          ...chartOptions.scales.y,
                          max: 100,
                          min: 0,
                          title: {
                            display: true,
                            text: 'Usage (%)'
                          }
                        }
                      }
                    }}
                  />
                ) : (
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#666' }}>
                    No CPU or RAM data available
                  </div>
                )}
              </div>
            </div>

            {/* Disk I/O - Non-MySQL */}
            <div style={{ 
              width: '100%',
              backgroundColor: 'white', 
              padding: '20px', 
              borderRadius: '5px', 
              boxShadow: '0 2px 4px rgba(0,0,0,0.1)' 
            }}>
              <h3 style={{ marginTop: 0, marginBottom: '15px' }}>Disk I/O (MB/min) - Non-MySQL (Solid: Read, Dashed: Write)</h3>
              <div style={{ height: '350px' }}>
                {diskOthersChartData.datasets.length > 0 ? (
                  <Line data={diskOthersChartData} options={chartOptions} />
                ) : (
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#666' }}>
                    No disk I/O data for non-MySQL services
                  </div>
                )}
              </div>
            </div>

            {/* Disk I/O - MySQL */}
            <div style={{ 
              width: '100%',
              backgroundColor: 'white', 
              padding: '20px', 
              borderRadius: '5px', 
              boxShadow: '0 2px 4px rgba(0,0,0,0.1)' 
            }}>
              <h3 style={{ marginTop: 0, marginBottom: '15px' }}>Disk I/O (MB/min) - MySQL (Solid: Read, Dashed: Write)</h3>
              <div style={{ height: '350px' }}>
                {diskMysqlChartData.datasets.length > 0 ? (
                  <Line data={diskMysqlChartData} options={chartOptions} />
                ) : (
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#666' }}>
                    No disk I/O data for MySQL services
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Metrics Table */}
          <div style={{ backgroundColor: 'white', padding: '15px', borderRadius: '5px', boxShadow: '0 2px 4px rgba(0,0,0,0.1)' }}>
            <h3 style={{ marginTop: 0 }}>Latest Metrics Data (All Servers)</h3>
            <div style={{ overflowX: 'auto', maxHeight: '400px', overflowY: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px' }}>
                <thead style={{ position: 'sticky', top: 0, backgroundColor: '#f5f5f5', zIndex: 10 }}>
                  <tr>
                    <th style={{ padding: '10px', textAlign: 'left', borderBottom: '2px solid #ddd' }}>Server</th>
                    <th style={{ padding: '10px', textAlign: 'left', borderBottom: '2px solid #ddd' }}>Timestamp</th>
                    <th style={{ padding: '10px', textAlign: 'right', borderBottom: '2px solid #ddd' }}>CPU (%)</th>
                    <th style={{ padding: '10px', textAlign: 'right', borderBottom: '2px solid #ddd' }}>Memory (%)</th>
                    <th style={{ padding: '10px', textAlign: 'right', borderBottom: '2px solid #ddd' }}>Disk Read (MB/min)</th>
                    <th style={{ padding: '10px', textAlign: 'right', borderBottom: '2px solid #ddd' }}>Disk Write (MB/min)</th>
                    <th style={{ padding: '10px', textAlign: 'right', borderBottom: '2px solid #ddd' }}>Nginx Req/min</th>
                    <th style={{ padding: '10px', textAlign: 'right', borderBottom: '2px solid #ddd' }}>Total Read (MB)</th>
                    <th style={{ padding: '10px', textAlign: 'right', borderBottom: '2px solid #ddd' }}>Total Write (MB)</th>
                  </tr>
                </thead>
                <tbody>
                  {metricsData
                    .slice(-100)
                    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
                    .map((metric, index) => (
                      <tr key={index} style={{ borderBottom: '1px solid #eee' }}>
                        <td style={{ padding: '8px', fontWeight: '500' }}>{metric.server}</td>
                        <td style={{ padding: '8px' }}>{formatTimestamp(metric.timestamp)}</td>
                        <td style={{ padding: '8px', textAlign: 'right' }}>{metric.cpu_usage ? metric.cpu_usage.toFixed(2) : '-'}</td>
                        <td style={{ padding: '8px', textAlign: 'right' }}>{metric.mem_usage ? metric.mem_usage.toFixed(2) : '-'}</td>
                        <td style={{ padding: '8px', textAlign: 'right' }}>{metric.disk_read_mb_per_min ? metric.disk_read_mb_per_min.toFixed(2) : '-'}</td>
                        <td style={{ padding: '8px', textAlign: 'right' }}>{metric.disk_write_mb_per_min ? metric.disk_write_mb_per_min.toFixed(2) : '-'}</td>
                        <td style={{ padding: '8px', textAlign: 'right' }}>{metric.nginx_request_count_per_min || '-'}</td>
                        <td style={{ padding: '8px', textAlign: 'right' }}>{metric.disk_read_mb ? metric.disk_read_mb.toFixed(2) : '-'}</td>
                        <td style={{ padding: '8px', textAlign: 'right' }}>{metric.disk_write_mb ? metric.disk_write_mb.toFixed(2) : '-'}</td>
                    </tr>
                    ))}
                </tbody>
              </table>
            </div>
            <div style={{ marginTop: '10px', fontSize: '12px', color: '#666' }}>
              Showing latest 100 records (Total: {metricsData.length})
            </div>
          </div>
        </>
      )}
    </div>
  );
};

export default ServerMetrics;

