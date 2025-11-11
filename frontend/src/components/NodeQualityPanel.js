import React, { useCallback, useEffect, useMemo, useState } from 'react';
import './NodeQualityPanel.css';

const REFRESH_INTERVAL_MS = 30000;

const formatPercent = (value) => {
  if (value === null || value === undefined) {
    return '—';
  }
  return `${(value * 100).toFixed(1)}%`;
};

const formatNumber = (value) => {
  if (value === null || value === undefined) {
    return '—';
  }
  return value.toLocaleString();
};

const formatBandwidth = (value) => {
  if (value === null || value === undefined) {
    return '—';
  }
  return `${value.toFixed(2)} Mbps`;
};

const formatTrafficGbps = (value) => {
  if (value === null || value === undefined) {
    return '—';
  }
  return `${(value / 1000).toFixed(2)} Gbps`;
};

const formatRtt = (value) => {
  if (value === null || value === undefined) {
    return '—';
  }
  return `${Math.round(value)} ms`;
};

const formatDateTime = (value) => {
  if (!value) {
    return '—';
  }
  try {
    const date = new Date(value);
    return date.toLocaleString();
  } catch {
    return value;
  }
};

const DATA_CENTER_MAP = [
  { match: (company) => company?.toLowerCase() === 'melbikomas uab', label: 'Delta' },
  { match: (company) => company?.toLowerCase() === 'amazon.com, inc', label: 'Aws' },
  { match: (company) => company?.toLowerCase() === 'digitalocean, llc', label: 'DO' },
  {
    match: (company) =>
      !company ||
      company.toLowerCase() === 'unknown' ||
      company.toLowerCase().startsWith('mohsen nikk'),
    label: 'Ramda',
  },
  { match: (company) => company?.toLowerCase() === 'colocationx ltd', label: 'Pi' },
  { match: (company) => company?.toLowerCase() === 'rackdog, llc', label: 'OFF' },
];

const resolveDataCenterName = (company) => {
  const trimmed = company?.trim() || '';
  const mapping = DATA_CENTER_MAP.find((entry) => entry.match(trimmed));
  if (mapping) {
    return mapping.label;
  }
  return trimmed || 'Unknown';
};

const buildPortList = (snapshot) => {
  if (!snapshot) {
    return [];
  }
  const set = new Set();
  snapshot.ttl.blockedNodes.forEach((node) => set.add(node.proxyPort));
  snapshot.ttl.badNodes.forEach((node) => set.add(node.proxyPort));
  return Array.from(set).sort((a, b) => a - b);
};

const filterByPort = (items, port) => {
  if (!items || port === 'all') {
    return items || [];
  }
  return items.filter((item) => Number(item.proxyPort) === Number(port));
};

const NodeQualityPanel = () => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [snapshot, setSnapshot] = useState(null);
  const [emergency, setEmergency] = useState(null);
  const [selectedPort, setSelectedPort] = useState('all');
  const [showAnalytics, setShowAnalytics] = useState(false);
  const [showDailyAnalysis, setShowDailyAnalysis] = useState(false);
  const [dailyAnalysis, setDailyAnalysis] = useState(null);
  const [dailyAnalysisLoading, setDailyAnalysisLoading] = useState(false);
  const [dailyAnalysisError, setDailyAnalysisError] = useState('');
  const [sendingDailyReport, setSendingDailyReport] = useState(false);
  const [dailyReportStatus, setDailyReportStatus] = useState({ type: 'idle', message: '' });
  const [portMetadata, setPortMetadata] = useState([]);
  const [portsError, setPortsError] = useState('');

  const fetchSnapshot = useCallback(async () => {
    try {
      setLoading(true);
      setError('');
      const response = await fetch('/api/quality/current');
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || `Request failed (${response.status})`);
      }
      const data = await response.json();
      if (!data.success) {
        throw new Error(data.error || 'Failed to load data');
      }
      setSnapshot(data.snapshot);
      setEmergency(data.emergency);
    } catch (err) {
      console.error('❌ Failed to fetch quality snapshot:', err);
      setError(err.message || 'Failed to fetch quality snapshot');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSnapshot();
    const interval = setInterval(() => {
      fetchSnapshot();
    }, REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchSnapshot]);

  const fetchPorts = useCallback(async () => {
    try {
      setPortsError('');
      const response = await fetch('/api/ports');
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || `Request failed (${response.status})`);
      }
      const data = await response.json();
      if (!data.success) {
        throw new Error(data.error || 'Failed to load ports');
      }
      setPortMetadata(Array.isArray(data.ports) ? data.ports : []);
    } catch (err) {
      console.error('❌ Failed to fetch ports:', err);
      setPortsError(err.message || 'Failed to load port metadata');
      setPortMetadata([]);
    }
  }, []);

  useEffect(() => {
    fetchPorts();
  }, [fetchPorts]);

const snapshotPorts = useMemo(() => buildPortList(snapshot), [snapshot]);

useEffect(() => {
  if (!snapshotPorts || snapshotPorts.length === 0) {
    setSelectedPort('all');
    return;
  }
  if (selectedPort !== 'all' && !snapshotPorts.includes(Number(selectedPort))) {
    setSelectedPort(String(snapshotPorts[0]));
  }
}, [snapshotPorts, selectedPort]);

  const formatPortOptionLabel = useCallback((port) => {
    if (!port) {
      return '';
    }
    const country = port.countryShort || port.country || '';
    const provider = port.providerShort || port.provider || '';
    const shortLabel = [country, provider].filter(Boolean).join('·');
    return shortLabel ? `${shortLabel} (${port.portNumber})` : `Port ${port.portNumber}`;
  }, []);

  const portLabelMap = useMemo(() => {
    const map = new Map();
    portMetadata.forEach((port) => {
      map.set(String(port.portNumber), formatPortOptionLabel(port));
    });
    return map;
  }, [portMetadata, formatPortOptionLabel]);

  const portOptions = useMemo(() => {
    const optionMap = new Map();
    portMetadata.forEach((port) => {
      const value = String(port.portNumber);
      optionMap.set(value, formatPortOptionLabel(port));
    });
    snapshotPorts.forEach((port) => {
      const value = String(port);
      if (!optionMap.has(value)) {
        optionMap.set(value, `Port ${port}`);
      }
    });

    return Array.from(optionMap.entries())
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .map(([value, label]) => ({ value, label }));
  }, [portMetadata, snapshotPorts, formatPortOptionLabel]);

  const getPortLabel = useCallback(
    (portNumber, fallbackLabel = '') => {
      if (portNumber === undefined || portNumber === null) {
        return fallbackLabel;
      }
      const value = String(portNumber);
      return (
        portLabelMap.get(value) ||
        fallbackLabel ||
        `Port ${portNumber}`
      );
    },
    [portLabelMap]
  );

  const filteredBlocked = useMemo(
    () => filterByPort(snapshot?.ttl.blockedNodes, selectedPort),
    [snapshot, selectedPort]
  );

  const filteredBad = useMemo(
    () => filterByPort(snapshot?.ttl.badNodes, selectedPort),
    [snapshot, selectedPort]
  );

  const measurementIntervalMinutes = useMemo(() => {
    if (!emergency?.currentMeasurementIntervalMs) {
      return null;
    }
    return Math.round(emergency.currentMeasurementIntervalMs / 60000);
  }, [emergency]);

  const companyAnalytics = useMemo(() => {
    if (!snapshot) return [];

    const includeNodes = [...(snapshot.ttl.blockedNodes || []), ...(snapshot.ttl.badNodes || [])];
    const stats = new Map();

    includeNodes.forEach((node) => {
      if (selectedPort !== 'all' && Number(node.proxyPort) !== Number(selectedPort)) {
        return;
      }
      const company = node.dataCenter || resolveDataCenterName(node.company);
      if (!stats.has(company)) {
        stats.set(company, {
          company,
          total: 0,
          blocked: 0,
          bad: 0,
          ports: new Set(),
        });
      }
      const entry = stats.get(company);
      entry.total += 1;
      if (node.blocked) {
        entry.blocked += 1;
      } else {
        entry.bad += 1;
      }
      entry.ports.add(getPortLabel(node.proxyPort, `Port ${node.proxyPort}`));
    });

    return Array.from(stats.values())
      .map((entry) => ({
        ...entry,
        ports: Array.from(entry.ports).sort(),
      }))
      .sort((a, b) => b.total - a.total);
  }, [snapshot, selectedPort, getPortLabel]);

  const openDailyAnalysis = useCallback(async () => {
    setShowDailyAnalysis(true);
    setDailyAnalysisLoading(true);
    setDailyAnalysisError('');
    setDailyAnalysis(null);

    try {
      const params = new URLSearchParams();
      if (selectedPort !== 'all') {
        params.append('proxyPort', selectedPort);
      }
      const queryString = params.toString();
      const url = queryString ? `/api/quality/daily-analysis?${queryString}` : '/api/quality/daily-analysis';

      const response = await fetch(url);
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || `Request failed (${response.status})`);
      }

      const data = await response.json();
      if (!data.success) {
        throw new Error(data.error || 'Failed to analyze daily quality');
      }

      setDailyAnalysis(data);
    } catch (err) {
      console.error('❌ Failed to load daily quality analysis:', err);
      setDailyAnalysisError(err.message || 'Failed to analyze daily quality');
    } finally {
      setDailyAnalysisLoading(false);
    }
  }, [selectedPort]);

  const handleSendDailyReport = useCallback(async () => {
    setSendingDailyReport(true);
    setDailyReportStatus({ type: 'sending', message: '' });
    try {
      const payload = {};
      if (selectedPort !== 'all') {
        payload.proxyPort = Number(selectedPort);
      }

      const response = await fetch('/api/quality/daily-analysis/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.success) {
        throw new Error(data.error || `Request failed (${response.status})`);
      }
      if (data.analysis) {
        setDailyAnalysis(data.analysis);
      }
      const deliveries = Array.isArray(data.deliveries) ? data.deliveries : [];
      const sentCount = deliveries.filter((entry) => entry.sent).length;
      const totalCount = deliveries.length || (data.recipients ?? 0);
      const failed = deliveries.filter((entry) => !entry.sent);
      let message = `Sent to ${sentCount}/${totalCount} recipient${totalCount === 1 ? '' : 's'}.`;
      if (failed.length > 0) {
        const details = failed
          .map((entry) => {
            const target = entry.chatId || entry.contactId || 'unknown';
            const reason = entry.error || 'send_failed';
            return `${target}: ${reason}`;
          })
          .join(', ');
        message += ` Failed deliveries: ${details}`;
      }
      setDailyReportStatus({
        type: failed.length > 0 ? 'warning' : 'success',
        message,
      });
    } catch (err) {
      console.error('❌ Failed to send daily report:', err);
      setDailyReportStatus({
        type: 'error',
        message: err.message || 'Failed to send daily summary',
      });
    } finally {
      setSendingDailyReport(false);
    }
  }, [selectedPort]);

  return (
    <div className="page-content quality-panel">
      <header className="quality-header">
        <h1>Node Quality</h1>
        <div className="quality-header-actions">
          <button className="refresh-button" onClick={fetchSnapshot} disabled={loading}>
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </header>

      {error && <div className="quality-banner warning">{error}</div>}

      {snapshot ? (
        <>
          <section className="quality-filters">
            <div className="quality-filter-group">
              <label htmlFor="port-filter">Proxy port</label>
              <select
                id="port-filter"
                value={selectedPort}
                onChange={(event) => setSelectedPort(event.target.value)}
              >
                <option value="all">All ports</option>
                {portOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              {portsError && <span className="quality-filter-hint">{portsError}</span>}
            </div>
            <div className="analysis-button-group">
              <button
                type="button"
                className="analytics-button"
                onClick={() => setShowAnalytics(true)}
                disabled={!companyAnalytics.length}
              >
                Company analytics
              </button>
              <button
                type="button"
                className="analysis-button"
                onClick={openDailyAnalysis}
                disabled={dailyAnalysisLoading}
              >
                Daily quality
              </button>
              <button
                type="button"
                className="analysis-button secondary"
                onClick={handleSendDailyReport}
                disabled={sendingDailyReport}
              >
                {sendingDailyReport ? 'Sending…' : 'Send daily summary'}
              </button>
            </div>
            {dailyReportStatus.message && (
              <div className={`daily-analysis-status ${dailyReportStatus.type}`}>
                {dailyReportStatus.message}
              </div>
            )}
          </section>

          <section className="quality-tables">
            <div className="quality-table-block">
              <div className="quality-table-header">
                <h2>Blocked Nodes</h2>
                <span className="quality-table-count">{filteredBlocked.length} nodes</span>
              </div>
              <div className="quality-table-scroll">
                <table className="quality-two-column">
                  <tbody>
                    {filteredBlocked.length === 0 ? (
                      <tr>
                        <td className="quality-table-empty">No blocked nodes detected.</td>
                        <td className="quality-table-empty" />
                      </tr>
                    ) : (
                      Array.from({ length: Math.ceil(filteredBlocked.length / 2) }).map(
                        (_, rowIndex) => {
                          const leftNode = filteredBlocked[rowIndex * 2] || null;
                          const rightNode = filteredBlocked[rowIndex * 2 + 1] || null;

                          const renderCell = (node) => {
                            if (!node) {
                              return <td />;
                            }
                            return (
                              <td>
                                <div className="quality-node-chip">
                                  <span className="quality-node-badge blocked">Blocked</span>
                                  <span className="mono">{node.targetHost}</span>
                                  <span className="quality-node-meta">
                                    DC {node.dataCenter || resolveDataCenterName(node.company)}
                                  </span>
                                  <span className="quality-node-meta">
                                    {getPortLabel(node.proxyPort)} • {formatDateTime(node.lastSeen)}
                                  </span>
                                  <span className="quality-node-meta">
                                    Attempts {formatNumber(node.sampleCount)}
                                  </span>
                                  <span className="quality-node-meta">
                                    Bad rate {formatPercent(node.badRate ?? 1)}
                                  </span>
                                </div>
                              </td>
                            );
                          };

                          return (
                            <tr key={`blocked-row-${rowIndex}`}>
                              {renderCell(leftNode)}
                              {renderCell(rightNode)}
                            </tr>
                          );
                        }
                      )
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="quality-table-block">
              <div className="quality-table-header">
                <h2>High RTT &amp; Low Traffic</h2>
                <span className="quality-table-count">{filteredBad.length} nodes</span>
              </div>
              <div className="quality-table-scroll">
                <table className="quality-two-column">
                  <tbody>
                    {filteredBad.length === 0 ? (
                      <tr>
                        <td className="quality-table-empty">
                          No high-latency, low-traffic nodes detected.
                        </td>
                        <td className="quality-table-empty" />
                      </tr>
                    ) : (
                      Array.from({ length: Math.ceil(filteredBad.length / 2) }).map(
                        (_, rowIndex) => {
                          const leftNode = filteredBad[rowIndex * 2] || null;
                          const rightNode = filteredBad[rowIndex * 2 + 1] || null;

                          const renderCell = (node) => {
                            if (!node) {
                              return <td />;
                            }
                            return (
                              <td>
                                <div className="quality-node-chip">
                                  <span className="quality-node-badge bad">High RTT</span>
                                  <span className="mono">{node.targetHost}</span>
                                  <span className="quality-node-meta">
                                    DC {node.dataCenter || resolveDataCenterName(node.company)}
                                  </span>
                                  <span className="quality-node-meta">
                                    {getPortLabel(node.proxyPort)} • {formatDateTime(node.lastSeen)}
                                  </span>
                                  <span className="quality-node-meta">
                                    RTT {formatRtt(node.avgRtt)} •{' '}
                                    {node.bandwidthInfo
                                      ? formatBandwidth(node.bandwidthInfo.avgBandwidth)
                                      : '—'}
                                  </span>
                                  <span className="quality-node-meta">
                                    Bad rate {formatPercent(node.badRate ?? Math.max(0, 1 - (node.successRate ?? 0)))}
                                  </span>
                                </div>
                              </td>
                            );
                          };

                          return (
                            <tr key={`bad-row-${rowIndex}`}>
                              {renderCell(leftNode)}
                              {renderCell(rightNode)}
                            </tr>
                          );
                        }
                      )
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </section>

          <footer className="quality-footer-status">
            <div className="quality-status-group">
              <span className="quality-status-label">Window</span>
              <div className="quality-status-values">
                <span className="quality-status-primary">{formatDateTime(snapshot.windowStart)}</span>
                <span className="quality-status-meta">→ {formatDateTime(snapshot.windowEnd)}</span>
              </div>
            </div>
            <div className="quality-status-group">
              <span className="quality-status-label">TTL</span>
              <div className="quality-status-values">
                <span className="quality-status-primary">
                  {formatNumber(snapshot.ttl.blockedNodes.length)} blocked
                </span>
                <span className="quality-status-meta">
                  High RTT {formatNumber(snapshot.ttl.badNodes.length)}
                </span>
                <span className="quality-status-meta">
                  Bad rate {formatPercent(snapshot.ttl.badRate)}
                </span>
              </div>
            </div>
            <div className="quality-status-group">
              <span className="quality-status-label">Traffic</span>
              <div className="quality-status-values">
                <span className="quality-status-primary">
                  {formatTrafficGbps(snapshot.bandwidth.totalTrafficMbps)}
                </span>
                <span className="quality-status-meta">
                  Degraded {formatNumber(snapshot.bandwidth.badNodes.length)}
                </span>
              </div>
            </div>
            <div className="quality-status-group">
              <span className="quality-status-label">Interval</span>
              <div className="quality-status-values">
                <span className="quality-status-primary">
                  {measurementIntervalMinutes ? `${measurementIntervalMinutes} min` : '—'}
                </span>
              </div>
            </div>
          </footer>
        </>
      ) : (
        !loading && (
          <div className="quality-placeholder">
            Quality data has not been generated yet. Run measurements or wait for the next aggregation cycle.
          </div>
        )
      )}

      {showAnalytics && (
        <div className="quality-modal-backdrop" onClick={() => setShowAnalytics(false)}>
          <div className="quality-modal" onClick={(event) => event.stopPropagation()}>
            <div className="quality-modal-header">
              <h3>Company analytics</h3>
              <button
                type="button"
                className="modal-close-button"
                onClick={() => setShowAnalytics(false)}
              >
                ×
              </button>
            </div>
            <div className="quality-modal-body">
              {companyAnalytics.length === 0 ? (
                <div className="quality-table-empty">No company data available.</div>
              ) : (
                <table className="quality-analytics-table">
                  <thead>
                    <tr>
                      <th>Company</th>
                      <th>Ports</th>
                      <th>Blocked</th>
                      <th>High RTT</th>
                      <th>Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {companyAnalytics.map((entry) => (
                      <tr key={entry.company}>
                        <td>{entry.company}</td>
                        <td>{entry.ports.join(', ') || '—'}</td>
                        <td>{formatNumber(entry.blocked)}</td>
                        <td>{formatNumber(entry.bad)}</td>
                        <td>{formatNumber(entry.total)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}

      {showDailyAnalysis && (
        <div
          className="quality-modal-backdrop"
          onClick={() => {
            setShowDailyAnalysis(false);
            setDailyAnalysisError('');
          }}
        >
          <div
            className="quality-modal large"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="quality-modal-header">
              <h3>Daily quality overview</h3>
              <button
                type="button"
                className="modal-close-button"
                onClick={() => {
                  setShowDailyAnalysis(false);
                  setDailyAnalysisError('');
                }}
              >
                ×
              </button>
            </div>
            <div className="quality-modal-body daily-analysis-body">
              {dailyAnalysisLoading ? (
                <div className="quality-table-empty">Analyzing last 24 hours…</div>
              ) : dailyAnalysisError ? (
                <div className="quality-table-empty">{dailyAnalysisError}</div>
              ) : dailyAnalysis ? (
                <>
                  <div className="daily-analysis-range">
                    {formatDateTime(dailyAnalysis.windowStart)} → {formatDateTime(dailyAnalysis.windowEnd)}
                  </div>
                  {dailyAnalysis.ports && dailyAnalysis.ports.length > 0 ? (
                    dailyAnalysis.ports.map((portSummary) => (
                    <div className="daily-analysis-section" key={`daily-port-${portSummary.proxyPort}`}>
                      <div className="daily-analysis-heading">
                        <h4>{portSummary.portLabel || getPortLabel(portSummary.proxyPort)}</h4>
                        <span className="daily-analysis-meta">
                          {portSummary.totalNodes} nodes • {portSummary.totalWindows} windows
                          {portSummary.totalBlockedMinutes
                            ? ` • ${portSummary.totalBlockedMinutes} min blocked`
                            : ''}
                        </span>
                      </div>
                        <div className="daily-analysis-grid">
                          {portSummary.topBadNodes && portSummary.topBadNodes.length > 0 ? (
                            portSummary.topBadNodes.map((node) => (
                              <div className="daily-analysis-card" key={`top-node-${portSummary.proxyPort}-${node.targetHost}`}>
                                <span className="daily-analysis-label">Degraded node</span>
                                <strong className="daily-analysis-primary">
                                  {node.targetHost}
                                  {node.targetPort && node.targetPort !== 80 ? `:${node.targetPort}` : ''}
                                </strong>
                                <span className="daily-analysis-sub">DC {node.dataCenter}</span>
                                <span className="daily-analysis-metric">
                                  Windows affected: {node.badWindows} / {node.windowCount}
                                </span>
                                <span className="daily-analysis-metric">
                                  Avg RTT: {node.avgRttMs !== null ? `${Math.round(node.avgRttMs)} ms` : '—'}
                                </span>
                                <span className="daily-analysis-metric">
                                  Avg traffic: {node.avgTrafficMbps !== null ? `${node.avgTrafficMbps.toFixed(2)} Mbps` : '—'}
                                </span>
                                <span className="daily-analysis-metric">
                                  Failure rate: {formatPercent(node.failureRate)}
                                </span>
                              </div>
                            ))
                          ) : (
                            <div className="quality-table-empty">No degraded nodes.</div>
                          )}
                        </div>
                        {portSummary.blockedNodes && portSummary.blockedNodes.length > 0 && (
                          <div className="daily-analysis-card">
                            <span className="daily-analysis-label">Blocked nodes</span>
                            <ul className="daily-analysis-list">
                              {portSummary.blockedNodes.map((node) => (
                                <li key={`blocked-node-${portSummary.proxyPort}-${node.targetHost}`}>
                                  <span className="daily-analysis-primary">
                                    {node.targetHost}
                                    {node.targetPort && node.targetPort !== 80 ? `:${node.targetPort}` : ''}
                                  </span>
                                  <span className="daily-analysis-metric">
                                    DC {node.dataCenter || 'Unknown'} • {node.blockedMinutes} min
                                  </span>
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                    </div>
                    ))
                  ) : (
                    <div className="quality-table-empty">No quality issues detected during the selected day.</div>
                  )}
                </>
              ) : (
                <div className="quality-table-empty">No quality issues detected during the selected day.</div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default NodeQualityPanel;

