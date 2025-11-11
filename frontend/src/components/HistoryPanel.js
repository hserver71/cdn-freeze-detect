import React, { useState, useEffect, useCallback, useRef } from 'react';
import axios from 'axios';

const HistoryPanel = () => {
    const [chartData, setChartData] = useState(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const [period, setPeriod] = useState('24h');
    const [proxyPort, setProxyPort] = useState('10220');
    const [lastRefresh, setLastRefresh] = useState(null);
    const [displaySeries, setDisplaySeries] = useState([]);
    const [ipInfoMap, setIpInfoMap] = useState({});
    const [selectedSegment, setSelectedSegment] = useState(null);
    const [selectedCompany, setSelectedCompany] = useState('');
    const [availableCompanies, setAvailableCompanies] = useState([]);
    const [selectedIP, setSelectedIP] = useState(null); // NEW: For company highlighting
    const [sortField, setSortField] = useState(null);
    const [sortOrder, setSortOrder] = useState('asc');
    const heatmapContainerRef = useRef(null);

    const periods = [
        { value: '6h', label: 'Last 6 hours' },
        { value: '24h', label: 'Last 24 hours' },
        { value: '7d', label: 'Last 7 days' },
        { value: '30d', label: 'Last 30 days' }
    ];

    const ipPanelWidth = 220;

    // Fetch companies for dropdown
    const fetchCompanies = useCallback(async () => {
        try {
            console.log('🏢 Fetching companies for dropdown...');
            const response = await axios.get(
                `/api/companies/historical`,
                {
                    params: { proxyPort, period },
                    timeout: 30000
                }
            );
            if (response.data.success) {
                setAvailableCompanies(response.data.companies);
                console.log(`✅ Loaded ${response.data.companies.length} companies for dropdown`);
            }
        } catch (err) {
            console.error('❌ Error fetching companies:', err);
        }
    }, [proxyPort, period]);

    // Fetch chart data WITHOUT pagination
    const fetchChartData = useCallback(async () => {
        setLoading(true);
        try {
            console.log(`📊 Fetching ALL chart data...`);
            const response = await axios.get(`/api/history/chart-data`, {
                params: {
                    proxyPort,
                    period,
                    company: selectedCompany
                },
                timeout: 50000
            });

            if (response.data.success) {
                setChartData(response.data);
                const series = response.data.chartData?.series || [];
                setDisplaySeries(series);

                // Set company data for IPs
                setIpInfoMap(response.data.chartData?.companies || {});


                // Update last refresh time
                setLastRefresh(new Date());

                console.log(`✅ Chart data loaded: ${series.length} IPs`);
            }
        } catch (err) {
            console.error('❌ Error fetching chart data:', err);
            setError(err.message);
        } finally {
            setLoading(false);
        }
    }, [proxyPort, period, selectedCompany]);


    const sortDisplaySeries = useCallback((field, order) => {
        const sorted = [...displaySeries].sort((a, b) => {
            const aCompany = (ipInfoMap[a.target_host]?.company || '').toLowerCase();
            const bCompany = (ipInfoMap[b.target_host]?.company || '').toLowerCase();
            const aRtt = a.totalAvgRtt ?? Infinity;
            const bRtt = b.totalAvgRtt ?? Infinity;

            if (field === 'company') {
                if (aCompany < bCompany) return order === 'asc' ? -1 : 1;
                if (aCompany > bCompany) return order === 'asc' ? 1 : -1;
                return 0;
            } else if (field === 'rtt') {
                return order === 'asc' ? aRtt - bRtt : bRtt - aRtt;
            }
            return 0;
        });
        setDisplaySeries(sorted);
    }, [displaySeries, ipInfoMap]);
    const handleSort = (field) => {
        let newOrder = 'asc';
        if (sortField === field && sortOrder === 'asc') {
            newOrder = 'desc';
        }
        setSortField(field);
        setSortOrder(newOrder);
        sortDisplaySeries(field, newOrder);
    };
    // Load data in parallel on mount

    // Handle IP selection for company highlighting
    const handleIPClick = useCallback((ip) => {
        if (selectedIP === ip) {
            setSelectedIP(null); // Deselect if same IP clicked
        } else {
            setSelectedIP(ip);
        }
    }, [selectedIP]);

    // Get company for selected IP
    const getSelectedCompany = () => {
        if (!selectedIP) return null;
        return ipInfoMap[selectedIP]?.company || null;
    };

    // NEW: Check if IP should be highlighted (same company as selected IP)
    const shouldHighlightIP = (ip) => {
        if (!selectedIP) return false;
        const selectedCompany = getSelectedCompany();
        const currentCompany = ipInfoMap[ip]?.company;
        return selectedCompany && currentCompany && selectedCompany === currentCompany;
    };

    const handleSegmentClick = useCallback((segment, ipInfo, timePoint) => {
        const ipData = ipInfoMap[ipInfo.target_host] || {};
        setSelectedSegment({
            ip: ipInfo.target_host,
            company: ipData.company || '',
            timeRange: formatTimeRange(timePoint.start, timePoint.end),
            startTime: timePoint.start,
            endTime: timePoint.end,
            avgRtt: segment.avgRtt,
            measurementCount: segment.measurementCount,
            successCount: segment.successCount,
            successRate: segment.successRate,
            status: segment.avgRtt !== null ? 'success' : 'no_data'
        });
    }, [ipInfoMap]);

    const handleRefresh = () => {
        Promise.all([
            fetchCompanies(),
            fetchChartData()
        ]);
    };

    const handleCompanyChange = (company) => {
        setSelectedCompany(company);
        setSelectedIP(null); // Reset selection when company changes
    };

    const getHeatmapColor = (avgRtt, status, isHighlighted, successRate = 1) => {
        // Case 1: error → gray gradient by success rate
        if (status === 'error') {
            // successRate: 0 → 1 → dark gray → light gray
            const grayValue = Math.floor(50 + successRate * 150); // 50~200
            const r = grayValue;
            const g = grayValue;
            const b = grayValue;

            if (isHighlighted) {
                // brighten slightly for highlighting
                return `rgb(${Math.min(255, r + 30)}, ${Math.min(255, g + 30)}, ${Math.min(255, b + 30)})`;
            }

            return `rgb(${r}, ${g}, ${b})`;
        }

        // Case 2: no data
        if (status === 'no_data' || avgRtt === null) return '#f0f0f0';

        // Case 3: RTT-based gradient
        // const step = 100; // 100ms per color step
        const cappedRtt = Math.min(avgRtt, 3000); // cap at 3000ms
        // const normalized = cappedRtt / 3000; // 0 → 1 range

        // Gradients:
        // 0ms → Green (#22c55e)
        // 1500ms → Yellow (#facc15)
        // 3000ms → Red (#dc2626)

        let r, g, b;

        if (cappedRtt <= 1200) {
            // Green → Yellow
            const ratio = cappedRtt / 1200;
            r = 34 + (250 - 34) * ratio;  // 22c55e → facc15
            g = 197 + (204 - 197) * ratio;
            b = 94 + (21 - 94) * ratio;
        } else {
            // Yellow → Red
            const ratio = (cappedRtt - 1200) / 1200;
            r = 250 + (220 - 250) * ratio;
            g = 204 + (38 - 204) * ratio;
            b = 21 + (38 - 21) * ratio;
        }

        r = Math.floor(r);
        g = Math.floor(g);
        b = Math.floor(b);

        // Highlight effect: brighten slightly
        if (isHighlighted) {
            r = Math.min(255, r + 30);
            g = Math.min(255, g + 30);
            b = Math.min(255, b + 30);
        }

        return `rgb(${r}, ${g}, ${b})`;
    };


    const renderHeatmap = () => {
        if (!chartData || !displaySeries || displaySeries.length === 0) {
            return <div className="no-data">No chart data available</div>;
        }

        const { timePoints, segmentCount } = chartData.chartData;
        const selectedCompany = getSelectedCompany();

        const ipCount = displaySeries.length;
        const cellSize = 20;
        const cellSpacing = 1;
        const headerHeight = 60;

        const heatmapPanelWidth = segmentCount * (cellSize + cellSpacing) + 40;
        const totalWidth = ipPanelWidth + heatmapPanelWidth;
        const heatmapHeight = headerHeight + (ipCount * (cellSize + cellSpacing));

        return (
            <div className="heatmap-container" style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
                <div
                    className="heatmap-scroll-container"
                    ref={heatmapContainerRef}
                    style={{
                        flex: 1,
                        minHeight: '400px',
                        maxHeight: 'none'
                    }}
                >
                    <div
                        className="heatmap-wrapper"
                        style={{
                            width: `${Math.max(totalWidth, 1200)}px`,
                            height: `${Math.max(heatmapHeight, 500)}px`,
                            display: 'flex'
                        }}
                    >
                        {/* IP PANEL */}
                        <div
                            className="ip-panel"
                            style={{
                                width: `${ipPanelWidth}px`,
                                height: '100%',
                                backgroundColor: '#f8f9fa',
                                borderRight: '2px solid #e5e7eb',
                                position: 'sticky',
                                left: 0,
                                zIndex: 1000,
                                boxShadow: '2px 0 5px rgba(0,0,0,0.1)'
                            }}
                        >
                            <div
                                style={{
                                    height: `${headerHeight}px`,
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'space-between',
                                    padding: '0 10px',
                                    borderBottom: '1px solid #e5e7eb',
                                    backgroundColor: '#f1f5f9',
                                    fontWeight: '600',
                                    color: '#374151',
                                    fontSize: '12px',
                                    position: 'sticky',
                                    top: 0,
                                    zIndex: 1010,
                                    cursor: 'pointer'
                                }}
                            >
                                <div
                                    style={{ flex: 1, textAlign: 'left' }}
                                    onClick={() => handleSort('company')}
                                    title="Sort by company"
                                >
                                    IP Address · Company
                                    {sortField === 'company' && (
                                        <span style={{ marginLeft: '4px' }}>{sortOrder === 'asc' ? '▲' : '▼'}</span>
                                    )}
                                </div>
                                <div
                                    style={{ width: '40px', textAlign: 'right' }}
                                    onClick={() => handleSort('rtt')}
                                    title="Sort by Avg RTT"
                                >
                                    RTT
                                    {sortField === 'rtt' && (
                                        <span style={{ marginLeft: '4px' }}>{sortOrder === 'asc' ? '▲' : '▼'}</span>
                                    )}
                                </div>
                            </div>

                            <div style={{ height: `calc(100% - ${headerHeight}px)`, overflow: 'hidden' }}>
                                {displaySeries.map((ipInfo, rowIndex) => {
                                    const avgRtt = ipInfo.totalAvgRtt;
                                    const ipData = ipInfoMap[ipInfo.target_host] || {};
                                    const isHighlighted = shouldHighlightIP(ipInfo.target_host);
                                    const isSelected = selectedIP === ipInfo.target_host;

                                    let rttColor = '#6b7280';
                                    if (avgRtt !== null && !isNaN(avgRtt)) {
                                        if (avgRtt < 1000) rttColor = '#22c55e';
                                        else if (avgRtt < 2000) rttColor = '#f97316';
                                        else rttColor = '#dc2626';
                                    }

                                    return (
                                        <div
                                            key={`ip-row-${rowIndex}`}
                                            style={{
                                                height: `${cellSize + cellSpacing}px`,
                                                display: 'flex',
                                                alignItems: 'center',
                                                justifyContent: 'space-between',
                                                padding: '0 15px',
                                                borderBottom: '1px solid #f1f5f9',
                                                backgroundColor: isHighlighted ? '#fff3cd' :
                                                    isSelected ? '#e7f3ff' :
                                                        rowIndex % 2 === 0 ? '#ffffff' : '#fafafa',
                                                fontSize: '11px',
                                                position: 'relative',
                                                cursor: 'pointer',
                                                borderLeft: isSelected ? '3px solid #007bff' : '3px solid transparent',
                                                borderRight: isHighlighted ? '2px solid #ffc107' : 'none'
                                            }}
                                            onClick={() => handleIPClick(ipInfo.target_host)}
                                            title={`IP: ${ipInfo.target_host}\nCompany: ${ipData.company || 'Not available'}\nAvg RTT: ${avgRtt !== null ? avgRtt.toFixed(0) + 'ms' : 'No data'}\nStatus: ${ipInfo.isLive ? 'Live' : 'Historical'}\n${isHighlighted ? 'Same company as selected' : ''}`}
                                        >
                                            <div style={{
                                                flex: 1,
                                                minWidth: 0,
                                                display: 'flex',
                                                flexDirection: 'column',
                                                gap: '1px'
                                            }}>
                                                <div style={{
                                                    display: 'flex',
                                                    alignItems: 'center',
                                                    gap: '8px',
                                                    overflow: 'hidden'
                                                }}>
                                                    <span style={{
                                                        fontWeight: '600',
                                                        color: ipInfo.isLive ? '#3b82f6' : '#374151',
                                                        fontFamily: 'Courier New, monospace',
                                                        fontSize: '10px',
                                                        flexShrink: 0
                                                    }}>
                                                        {ipInfo.target_host}
                                                    </span>

                                                    {ipData.company && (
                                                        <span style={{
                                                            color: '#6b7280',
                                                            fontSize: '9px',
                                                            overflow: 'hidden',
                                                            textOverflow: 'ellipsis',
                                                            whiteSpace: 'nowrap'
                                                        }}>
                                                            {ipData.company}
                                                        </span>
                                                    )}
                                                </div>
                                            </div>

                                            <div style={{
                                                color: rttColor,
                                                fontSize: '9px',
                                                fontWeight: '600',
                                                minWidth: '35px',
                                                textAlign: 'right',
                                                flexShrink: 0
                                            }}>
                                                {avgRtt !== null && !isNaN(avgRtt) ? `${avgRtt.toFixed(0)}ms` : ''}
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>

                        {/* HEATMAP PANEL */}
                        <div style={{ flex: 1, minWidth: `${heatmapPanelWidth}px`, position: 'relative' }}>
                            <svg
                                width={heatmapPanelWidth}
                                height={Math.max(heatmapHeight, 500)}
                                className="heatmap-chart"
                            >
                                <rect
                                    width={heatmapPanelWidth}
                                    height={Math.max(heatmapHeight, 500)}
                                    fill="#f8f9fa"
                                />

                                {/* Timeline labels */}
                                {timePoints
                                    .map((timePoint, originalIndex) => ({ ...timePoint, originalIndex }))
                                    .filter((_, i) => i % 10 === 0 || i === timePoints.length - 1)
                                    .map((timePoint, i) => {
                                        const x = (timePoint.originalIndex * (cellSize + cellSpacing));

                                        const startLocal = new Date(timePoint.start);

                                        let label = '';
                                        if (period === '24h' || period === '6h') {
                                            label = startLocal.toLocaleTimeString('en-US', {
                                                hour: '2-digit',
                                                minute: '2-digit',
                                                hour12: false
                                            });
                                        } else {
                                            label = startLocal.toLocaleDateString('en-US', {
                                                month: 'short',
                                                day: 'numeric',
                                                hour: '2-digit',
                                                minute: '2-digit'
                                            });
                                        }

                                        return (
                                            <g key={`time-header-${i}`}>
                                                <line
                                                    x1={x}
                                                    y1={headerHeight - 40}
                                                    x2={x}
                                                    y2={headerHeight + (ipCount * (cellSize + cellSpacing))}
                                                    stroke="#e5e7eb"
                                                    strokeDasharray="2,2"
                                                    opacity="0.5"
                                                />
                                                <text
                                                    x={x + (cellSize / 2)}
                                                    y={headerHeight - 25}
                                                    textAnchor="middle"
                                                    fontSize="10"
                                                    fill="#374151"
                                                    fontWeight="500"
                                                >
                                                    {label}
                                                </text>
                                            </g>
                                        );
                                    })
                                }

                                {/* Heatmap segments */}
                                {displaySeries.map((ipInfo, rowIndex) => {
                                    const y = headerHeight + (rowIndex * (cellSize + cellSpacing));
                                    const isHighlighted = shouldHighlightIP(ipInfo.target_host);

                                    return (
                                        <g key={`heatmap-row-${rowIndex}`}>
                                            <line
                                                x1={0}
                                                y1={y}
                                                x2={heatmapPanelWidth}
                                                y2={y}
                                                stroke="#f1f5f9"
                                                strokeWidth="0.5"
                                            />

                                            {ipInfo.segments.map((segment, colIndex) => {
                                                const x = (colIndex * (cellSize + cellSpacing));
                                                let status = 'success';

                                                // Only show right border for last segment of selected rows
                                                const isLastSegment = colIndex === ipInfo.segments.length - 1;
                                                const shouldShowRightBorder = isLastSegment && (isHighlighted);
                                                if (segment.measurementCount == 0) {
                                                    status = 'no_data';
                                                } else if (segment.successRate <= 0.6) {
                                                    status = 'error';
                                                }

                                                const color = getHeatmapColor(segment.avgRtt, status, isHighlighted, segment.successRate);

                                                return (
                                                    <g key={`cell-${rowIndex}-${colIndex}`}>
                                                        {/* Main cell - NO BORDERS */}
                                                        <rect
                                                            x={x}
                                                            y={y}
                                                            width={cellSize}
                                                            height={cellSize}
                                                            fill={color}
                                                            stroke={status === 'error' ? 'gray' : 'none'}
                                                            strokeWidth="0.5"
                                                            className="heatmap-cell"
                                                            onClick={() => handleSegmentClick(segment, ipInfo, timePoints[colIndex])}
                                                            style={{ cursor: 'pointer' }}
                                                        />
                                                        {/* RIGHT BORDER ONLY - as a separate line */}
                                                        {shouldShowRightBorder && (
                                                            <line
                                                                x1={x + cellSize}
                                                                y1={y}
                                                                x2={x + cellSize}
                                                                y2={y + cellSize}
                                                                stroke="#007bff"
                                                                strokeWidth="2"
                                                            />
                                                        )}
                                                    </g>
                                                );
                                            })}
                                        </g>
                                    );
                                })}

                                <text
                                    x={heatmapPanelWidth / 2}
                                    y={20}
                                    textAnchor="middle"
                                    fontSize="12"
                                    fill="#374151"
                                    fontWeight="600"
                                >
                                    Time Segments ({periods.find(p => p.value === period)?.label})
                                </text>
                            </svg>
                        </div>
                    </div>
                </div>
            </div>
        );
    };

    // Time formatting functions
    const formatToLocalTime = (timestamp) => {
        if (!timestamp) return 'N/A';
        try {
            const date = new Date(timestamp);
            return date.toLocaleString('en-US', {
                month: 'short',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
                hour12: false
            });
        } catch (error) {
            return 'Invalid Date';
        }
    };

    const formatTimeRange = (startTime, endTime) => {
        const startLocal = formatToLocalTime(startTime);
        const endLocal = formatToLocalTime(endTime);
        return `${startLocal} - ${endLocal}`;
    };


    useEffect(() => {
        const loadInitialData = async () => {
            console.log('🚀 Loading initial data in parallel...');
            setLoading(true);
            try {
                await Promise.all([
                    fetchCompanies(),
                    fetchChartData()
                ]);
                console.log('✅ All initial data loaded successfully');
            } catch (err) {
                console.error('❌ Error loading initial data:', err);
            } finally {
                setLoading(false);
            }
        };

        loadInitialData();
    }, []);

    // Reload ONLY chart data when filters change
    useEffect(() => {
        if (chartData) {
            console.log('🔄 Filter changed, reloading chart data...');
            fetchChartData();
        }
    }, [period, proxyPort, selectedCompany]);



    return (
        <div className="history-panel" style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
            <div className="panel-header" style={{ flexShrink: 0 }}>
                {/* <h2>📈 Historical Ping Result</h2> */}
                <div className="controls">
                    <div className="control-group">
                        <div className="control-item">
                            <select
                                id="historyProxy"
                                value={proxyPort}
                                onChange={(e) => setProxyPort(e.target.value)}
                            >
                                <option value="10220">🇪🇸 Spain (10220)</option>
                                <option value="10041">🇬🇧 UK (10041)</option>
                                <option value="10079">🇨🇦 CA-BE (10079)</option>
                                <option value="10238">Italy & SPA (10238)</option>
                                <option value="10038">🇵🇹 Portugal (10038)</option>
                            </select>
                        </div>

                        <div className="control-item">
                            <label htmlFor="historyPeriod">Period: </label>
                            <select
                                id="historyPeriod"
                                value={period}
                                onChange={(e) => setPeriod(e.target.value)}
                            >
                                {periods.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
                            </select>
                        </div>

                        {/* Company Filter */}
                        <div className="control-item">
                            <label htmlFor="companyFilter">Company: </label>
                            <select
                                id="companyFilter"
                                value={selectedCompany}
                                onChange={(e) => handleCompanyChange(e.target.value)}
                                disabled={loading}
                            >
                                <option value="">All Companies</option>
                                {availableCompanies.map((company, index) => (
                                    <option key={index} value={company} title={company}>
                                        {company && company.length > 25 ? company.substring(0, 25) + '...' : company}
                                    </option>
                                ))}
                            </select>
                        </div>
                    </div>

                    <button
                        onClick={handleRefresh}
                        disabled={loading}
                        className="btn btn-refresh"
                    >
                        {loading ? 'Loading...' : '🔄 Refresh'}
                    </button>

                    <div className="status-info">
                        <div>Total IPs: {displaySeries.length}</div>
                        {lastRefresh && (
                            <div>Updated: {lastRefresh.toLocaleTimeString()}</div>
                        )}
                    </div>
                </div>
            </div>

            {error && (
                <div className="error-message" style={{ flexShrink: 0 }}>
                    <strong>Note:</strong> {error}
                    <button className="error-close" onClick={() => setError(null)}>×</button>
                </div>
            )}

            <div className="chart-area" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                {loading ? (
                    <div className="loading">Loading chart data...</div>
                ) : (
                    renderHeatmap()
                )}
            </div>

            {/* Footer */}
            <div className="panel-footer" style={{
                height: '60px',
                display: 'flex',
                alignItems: 'center',
                overflow: 'hidden',
                flexShrink: 0
            }}>
                {selectedSegment ? (
                    <div style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '20px',
                        width: '100%',
                        flexWrap: 'wrap',
                        fontSize: '13px'
                    }}>
                        <div>
                            <strong>IP:</strong> {selectedSegment.ip}
                            {selectedSegment.company && (
                                <span style={{ marginLeft: '8px', color: '#6b7280' }}>
                                    ({selectedSegment.company})
                                </span>
                            )}
                        </div>
                        <div><strong>Time:</strong> {selectedSegment.timeRange}</div>
                        <div><strong>RTT:</strong>
                            <span style={{
                                color: selectedSegment.avgRtt > 1000 ? '#dc2626' :
                                    selectedSegment.avgRtt > 500 ? '#f97316' : '#22c55e',
                                fontWeight: 'bold',
                                marginLeft: '4px'
                            }}>
                                {selectedSegment.avgRtt !== null ? `${selectedSegment.avgRtt.toFixed(0)}ms` : 'No data'}
                            </span>
                        </div>
                        <div><strong>Packets:</strong> {selectedSegment.measurementCount}</div>
                        <div><strong>Success:</strong>
                            <span style={{
                                color: selectedSegment.successRate > 0.8 ? '#22c55e' :
                                    selectedSegment.successRate > 0.5 ? '#f97316' : '#dc2626',
                                fontWeight: 'bold',
                                marginLeft: '4px'
                            }}>
                                {((selectedSegment.successRate || 0) * 100).toFixed(0)}%
                            </span>
                        </div>
                    </div>
                ) : (
                    <div style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        width: '100%'
                    }}>
                        <div>
                            {displaySeries.length} IPs •
                            {selectedCompany && ` Company: ${selectedCompany}`}
                            {selectedIP && ` • Selected: ${selectedIP}`}
                        </div>
                        <div style={{ color: '#6b7280', fontSize: '0.9rem' }}>
                            {selectedIP ? 'Click IPs to highlight same company' : 'Click any segment to view details'}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};

export default HistoryPanel;