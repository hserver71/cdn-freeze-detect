import React, { useState, useEffect, useCallback } from 'react';
import axios from 'axios';

const ErrorLogs = () => {
    const [errors, setErrors] = useState([]);
    const [loading, setLoading] = useState(false);
    const [collecting, setCollecting] = useState(false);
    const [selectedError, setSelectedError] = useState(null);
    const [selectedField, setSelectedField] = useState('');
    const [servers, setServers] = useState([]);
    const [filters, setFilters] = useState({
        server_ip: '',
        log_level: '',
        start_date: '',
        end_date: ''
    });

    const fetchErrorLogs = useCallback(async () => {
        setLoading(true);
        try {
            console.log('🔄 Fetching error logs with filters:', filters);

            const params = new URLSearchParams();
            Object.keys(filters).forEach(key => {
                if (filters[key]) params.append(key, filters[key]);
            });

            const response = await axios.get(`/api/errors?${params}`);

            if (response.data.success) {
                setErrors(response.data.data);
                console.log(`✅ Loaded ${response.data.data.length} error logs`);
            } else {
                console.error('❌ API returned error:', response.data.error);
                alert('Failed to fetch error logs: ' + (response.data.error || 'Unknown error'));
            }
        } catch (error) {
            console.error('❌ Error fetching error logs:', error);
            alert('Failed to fetch error logs. Check console for details.');
        } finally {
            setLoading(false);
        }
    }, [filters]);

    const handleCopyToClipboard = (text) => {
        // Try modern clipboard API first
        if (navigator.clipboard && window.isSecureContext) {
            navigator.clipboard.writeText(text)
                .then(() => {
                    alert('✅ Copied to clipboard!');
                })
                .catch(() => {
                    // Fallback to prompt method
                    showCopyPrompt(text);
                });
        } else {
            // Use prompt fallback
            showCopyPrompt(text);
        }
    };

    const showCopyPrompt = (text) => {
        const textArea = document.createElement('textarea');
        textArea.value = text;
        document.body.appendChild(textArea);
        textArea.select();

        try {
            const successful = document.execCommand('copy');
            document.body.removeChild(textArea);

            if (successful) {
                alert('✅ Copied to clipboard!');
            } else {
                throw new Error('Copy command failed');
            }
        } catch (error) {
            // Final fallback - show prompt
            prompt('Please copy the text manually:', text);
        }
    };
    const showNotification = (message, type = 'success') => {
        // Remove existing notification
        const existingNotification = document.getElementById('copy-notification');
        if (existingNotification) {
            existingNotification.remove();
        }

        // Create notification element
        const notification = document.createElement('div');
        notification.id = 'copy-notification';
        notification.innerHTML = message;
        notification.style.cssText = `
            position: fixed;
            top: 50px;
            right: 20px;
            background: ${type === 'success' ? '#28a745' : '#dc3545'};
            color: white;
            padding: 12px 20px;
            border-radius: 5px;
            box-shadow: 0 4px 6px rgba(0,0,0,0.1);
            z-index: 10000;
            font-size: 14px;
            font-weight: 500;
            animation: slideIn 0.3s ease-out;
        `;

        // Add styles for animation
        const style = document.createElement('style');
        style.innerHTML = `
            @keyframes slideIn {
                from { transform: translateX(100%); opacity: 0; }
                to { transform: translateX(0); opacity: 1; }
            }
        `;
        document.head.appendChild(style);

        document.body.appendChild(notification);

        // Auto remove after 2 seconds
        setTimeout(() => {
            if (notification.parentNode) {
                notification.parentNode.removeChild(notification);
            }
        }, 2000);
    };
    const handleCopyClick = (text) => {
        // Create a temporary textarea
        const textArea = document.createElement('textarea');
        textArea.value = text;
        document.body.appendChild(textArea);
        textArea.select();

        try {
            // Try to copy
            const successful = document.execCommand('copy');
            if (successful) {
                showNotification('✅ Copied!');
            } else {
                showNotification('❌ Failed!');
                // If copy fails, show prompt
                prompt('📋 Please copy the text manually:', text);
            }
        } catch (error) {
            // If everything fails, show prompt
            prompt('📋 Please copy the text manually:', text);
        } finally {
            // Clean up
            document.body.removeChild(textArea);
        }
    };
    const fetchLiveServers = async () => {
        try {
            const response = await axios.get('/api/measurements/live-servers');
            if (response.data.success) {
                setServers(response.data.servers);
            }
        } catch (error) {
            console.error('Error fetching live servers:', error);
        }
    };
    useEffect(() => {
        fetchErrorLogs();

        // Set up WebSocket for real-time updates
        const ws = new WebSocket(
          (window.location.protocol === 'https:' ? 'wss://' : 'ws://') +
          window.location.host +
          '/ws'
        );

        ws.onopen = () => {
            console.log('🔌 WebSocket connected for error logs');
        };

        ws.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                console.log('📨 WebSocket message:', data.type);

                if (data.type === 'new_errors') {
                    console.log('🔄 New errors detected, refreshing...');
                    fetchErrorLogs();
                }
            } catch (error) {
                console.error('❌ Error parsing WebSocket message:', error);
            }
        };

        ws.onerror = (error) => {
            console.error('❌ WebSocket error:', error);
        };

        ws.onclose = () => {
            console.log('🔌 WebSocket disconnected');
        };

        return () => ws.close();
    }, [fetchErrorLogs]);

    useEffect(() => {
        fetchLiveServers();
    }, []);
    const handleFilterChange = (key, value) => {
        setFilters(prev => ({ ...prev, [key]: value }));    
    };

    const handleCollectLogs = async () => {
        setCollecting(true);
        try {
            const response = await axios.post('/api/errors/collect');
            if (response.data.success) {
                alert(`Error log collection completed! ${response.data.totalLogs} new logs saved.`);
                fetchErrorLogs(); // Refresh the list
            } else {
                alert('Collection failed: ' + (response.data.error || 'Unknown error'));
            }
        } catch (error) {
            console.error('Error starting log collection:', error);
            alert('Failed to start log collection. Check console for details.');
        } finally {
            setCollecting(false);
        }
    };

    const clearFilters = () => {
        setFilters({
            server_ip: '',
            log_level: '',
            start_date: '',
            end_date: ''
        });
    };

    // Function to truncate long text
    const truncateText = (text, maxLength = 50) => {
        if (!text) return 'N/A';
        if (text.length <= maxLength) return text;
        return text.substring(0, maxLength) + '...';
    };

    // Function to handle cell click
    const handleCellClick = (error, field) => {
        setSelectedError(error);
        setSelectedField(field);
    };

    // Function to get field value for display
    const getFieldValue = (error, field) => {
        const value = error[field];
        if (!value) return 'N/A';

        switch (field) {
            case 'error_message':
                const firstPart = value.split(',')[0]; // Get text before first comma
                return truncateText(firstPart, 80);
            case 'upstream':
            case 'request':
                return truncateText(value, 40);
            case 'client_ip':
            case 'server_ip':
                return value;
            case 'original_timestamp':
                return new Date(value).toLocaleString();
            default:
                return truncateText(value, 30);
        }
    };

    // Function to get field label
    const getFieldLabel = (field) => {
        const labels = {
            original_timestamp: 'Timestamp',
            server_ip: 'Server IP',
            client_ip: 'Client IP',
            upstream: 'Upstream',
            request: 'Request',
            host: 'Host',
            error_message: 'Error Message',
            server_name: 'Server Name',
            nginx_pid: 'Nginx PID'
        };
        return labels[field] || field;
    };

    // Function to get full field value for dialog
    const getFullFieldValue = (error, field) => {
        const value = error[field];
        if (!value) return 'N/A';

        if (field === 'original_timestamp') {
            return new Date(value).toLocaleString();
        }
        return value;
    };

    return (
        <div className="error-logs" style={{ padding: '20px' }}>
            <header className="error-logs-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
                <h1>Nginx Error Logs</h1>
                <div>
                    <button
                        onClick={handleCollectLogs}
                        disabled={collecting}
                        style={{
                            padding: '10px 20px',
                            backgroundColor: collecting ? '#ccc' : '#007bff',
                            color: 'white',
                            border: 'none',
                            borderRadius: '4px',
                            cursor: collecting ? 'not-allowed' : 'pointer'
                        }}
                    >
                        {collecting ? '🔄 Collecting...' : '📥 Collect Logs Now'}
                    </button>
                    <button
                        onClick={fetchErrorLogs}
                        disabled={loading}
                        style={{
                            padding: '10px 20px',
                            backgroundColor: '#28a745',
                            color: 'white',
                            border: 'none',
                            borderRadius: '4px',
                            cursor: 'pointer',
                            marginLeft: '10px'
                        }}
                    >
                        {loading ? '🔄 Refreshing...' : '🔄 Refresh'}
                    </button>
                </div>
            </header>

            {/* Filters */}
            <div className="filters" style={{ marginBottom: '20px', padding: '15px', background: '#f8f9fa', borderRadius: '5px' }}>
                <h3>Filters</h3>
                <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
                    <select
                        value={filters.server_ip}
                        onChange={(e) => handleFilterChange('server_ip', e.target.value)}
                        style={{ padding: '8px', borderRadius: '4px', border: '1px solid #ddd' }}
                    >
                        <option value="">All Servers</option>
                        {servers.map(server => (
                            <option key={server.ip} value={server.ip}>
                                {server.ip} {server.alive ? '✅' : '❌'}
                            </option>
                        ))}
                    </select>

                    <input
                        type="date"
                        value={filters.start_date}
                        onChange={(e) => handleFilterChange('start_date', e.target.value)}
                        placeholder="Start Date"
                        style={{ padding: '8px', borderRadius: '4px', border: '1px solid #ddd' }}
                    />

                    <input
                        type="date"
                        value={filters.end_date}
                        onChange={(e) => handleFilterChange('end_date', e.target.value)}
                        placeholder="End Date"
                        style={{ padding: '8px', borderRadius: '4px', border: '1px solid #ddd' }}
                    />

                    <button
                        onClick={fetchErrorLogs}
                        style={{ padding: '8px 16px', backgroundColor: '#007bff', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' }}
                    >
                        Apply Filters
                    </button>

                    <button
                        onClick={clearFilters}
                        style={{ padding: '8px 16px', backgroundColor: '#6c757d', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' }}
                    >
                        Clear Filters
                    </button>
                </div>
            </div>

            {/* Error Logs Table */}
            <div className="error-logs-content">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                    <h3>Error Logs ({errors.length} records)</h3>
                    {loading && <div style={{ color: '#007bff' }}>🔄 Loading error logs...</div>}
                </div>

                <div className="error-logs-table" style={{ overflow: 'auto', maxHeight: '70vh', border: '1px solid #ddd', borderRadius: '5px' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
                        <thead style={{ position: 'sticky', top: 0, background: 'white', zIndex: 1 }}>
                            <tr>
                                <th style={{ border: '1px solid #ddd', padding: '12px', background: '#f8f9fa', textAlign: 'left' }}>Time</th>
                                <th style={{ border: '1px solid #ddd', padding: '12px', background: '#f8f9fa', textAlign: 'left' }}>Server IP</th>
                                <th style={{ border: '1px solid #ddd', padding: '12px', background: '#f8f9fa', textAlign: 'left' }}>Server Name</th>
                                <th style={{ border: '1px solid #ddd', padding: '12px', background: '#f8f9fa', textAlign: 'left' }}>Client IP</th>
                                <th style={{ border: '1px solid #ddd', padding: '12px', background: '#f8f9fa', textAlign: 'left' }}>Upstream</th>
                                <th style={{ border: '1px solid #ddd', padding: '12px', background: '#f8f9fa', textAlign: 'left' }}>Request</th>
                                <th style={{ border: '1px solid #ddd', padding: '12px', background: '#f8f9fa', textAlign: 'left' }}>Host</th>
                                <th style={{ border: '1px solid #ddd', padding: '12px', background: '#f8f9fa', textAlign: 'left' }}>Error Message</th>
                            </tr>
                        </thead>
                        <tbody>
                            {errors.map(error => (
                                <tr key={error.id}>
                                    <td
                                        style={{ border: '1px solid #ddd', padding: '10px', cursor: 'pointer' }}
                                        onClick={() => handleCopyClick(getFullFieldValue(error, 'original_timestamp'))}
                                        title="Click to copy timestamp"
                                    >
                                        {getFieldValue(error, 'original_timestamp')}
                                    </td>

                                    {/* Server IP - Copy on click */}
                                    <td
                                        style={{ border: '1px solid #ddd', padding: '10px', cursor: 'pointer' }}
                                        onClick={() => handleCopyClick(getFullFieldValue(error, 'server_ip'))}
                                        title="Click to copy server IP"
                                    >
                                        {getFieldValue(error, 'server_ip')}
                                    </td>

                                    {/* Server Name - Copy on click */}
                                    <td
                                        style={{ border: '1px solid #ddd', padding: '10px', cursor: 'pointer' }}
                                        onClick={() => handleCopyClick(getFullFieldValue(error, 'server_name'))}
                                        title="Click to copy server name"
                                    >
                                        {getFieldValue(error, 'server_name')}
                                    </td>

                                    {/* Client IP - Copy on click */}
                                    <td
                                        style={{ border: '1px solid #ddd', padding: '10px', cursor: 'pointer' }}
                                        onClick={() => handleCopyClick(getFullFieldValue(error, 'client_ip'))}
                                        title="Click to copy client IP"
                                    >
                                        {getFieldValue(error, 'client_ip')}
                                    </td>

                                    {/* Upstream - Copy on click */}
                                    <td
                                        style={{ border: '1px solid #ddd', padding: '10px', cursor: 'pointer' }}
                                        onClick={() => handleCopyClick(getFullFieldValue(error, 'upstream'))}
                                        title="Click to copy upstream"
                                    >
                                        {getFieldValue(error, 'upstream')}
                                    </td>

                                    {/* Request - Show modal on click */}
                                    <td
                                        style={{ border: '1px solid #ddd', padding: '10px', cursor: 'pointer' }}
                                        onClick={() => handleCellClick(error, 'request')}
                                        title="Click to view full request"
                                    >
                                        {getFieldValue(error, 'request')}
                                    </td>

                                    {/* Host - Copy on click */}
                                    <td
                                        style={{ border: '1px solid #ddd', padding: '10px', cursor: 'pointer' }}
                                        onClick={() => handleCopyClick(getFullFieldValue(error, 'host'))}
                                        title="Click to copy host"
                                    >
                                        {getFieldValue(error, 'host')}
                                    </td>

                                    {/* Error Message - Show modal on click */}
                                    <td
                                        style={{ border: '1px solid #ddd', padding: '10px', cursor: 'pointer' }}
                                        onClick={() => handleCellClick(error, 'error_message')}
                                        title="Click to view full error message"
                                    >
                                        {getFieldValue(error, 'error_message')}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>

                    {errors.length === 0 && !loading && (
                        <div style={{ textAlign: 'center', padding: '40px', color: '#6c757d' }}>
                            📝 No error logs found matching your filters
                        </div>
                    )}
                </div>
            </div>

            {/* Dialog for showing full content */}
            {selectedError && selectedField && (
                <div style={{
                    position: 'fixed',
                    top: 0,
                    left: 0,
                    right: 0,
                    bottom: 0,
                    backgroundColor: 'rgba(0,0,0,0.5)',
                    display: 'flex',
                    justifyContent: 'center',
                    alignItems: 'center',
                    zIndex: 1000
                }}>
                    <div style={{
                        backgroundColor: 'white',
                        padding: '20px',
                        borderRadius: '8px',
                        maxWidth: '80%',
                        maxHeight: '80%',
                        overflow: 'auto',
                        boxShadow: '0 4px 6px rgba(0,0,0,0.1)'
                    }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px' }}>
                            <h3>{getFieldLabel(selectedField)} - Full Content</h3>
                            <button
                                onClick={() => {
                                    setSelectedError(null);
                                    setSelectedField('');
                                }}
                                style={{
                                    background: 'none',
                                    border: 'none',
                                    fontSize: '18px',
                                    cursor: 'pointer',
                                    color: '#6c757d'
                                }}
                            >
                                ✕
                            </button>
                        </div>

                        <div style={{
                            backgroundColor: '#f8f9fa',
                            padding: '15px',
                            borderRadius: '4px',
                            fontFamily: 'monospace',
                            fontSize: '12px',
                            whiteSpace: 'pre-wrap',
                            wordBreak: 'break-all',
                            maxHeight: '400px',
                            overflow: 'auto'
                        }}>
                            {getFullFieldValue(selectedError, selectedField)}
                        </div>

                        <div style={{ marginTop: '15px', display: 'flex', gap: '10px' }}>
                            <button
                                onClick={() => handleCopyToClipboard(getFullFieldValue(selectedError, selectedField))}
                                style={{
                                    padding: '8px 16px',
                                    backgroundColor: '#007bff',
                                    color: 'white',
                                    border: 'none',
                                    borderRadius: '4px',
                                    cursor: 'pointer'
                                }}
                            >
                                Copy to Clipboard
                            </button>
                            <button
                                onClick={() => {
                                    setSelectedError(null);
                                    setSelectedField('');
                                }}
                                style={{
                                    padding: '8px 16px',
                                    backgroundColor: '#6c757d',
                                    color: 'white',
                                    border: 'none',
                                    borderRadius: '4px',
                                    cursor: 'pointer'
                                }}
                            >
                                Close
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

const getRowColor = (level) => {
    switch (level) {
        case 'error': return '#ffebee';
        case 'alert': return '#fff3e0';
        case 'warn': return '#fff8e1';
        default: return 'white';
    }
};


export default ErrorLogs;