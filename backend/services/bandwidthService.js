const { default: axios } = require('axios');

class BandwidthService {
    constructor(proxyService, databaseService) {
        this.proxyService = proxyService;
        this.databaseService = databaseService;
        this.bandwidthApiUrl = 'https://monitor.host-palace.net/get_all_bandwidth_list';
    }

    /**
     * Format Date object to MySQL TIMESTAMP format (YYYY-MM-DD HH:MM:SS)
     * Since MySQL timezone is set to UTC, this ensures UTC times are used correctly
     */
    formatToMySQLTimestamp(date) {
        if (!date) return null;
        
        // If it's a string, parse it to Date first
        const dateObj = date instanceof Date ? date : new Date(date);
        
        // Check if date is valid
        if (isNaN(dateObj.getTime())) {
            return null;
        }
        
        // Format to MySQL TIMESTAMP format: YYYY-MM-DD HH:MM:SS
        const year = dateObj.getUTCFullYear();
        const month = String(dateObj.getUTCMonth() + 1).padStart(2, '0');
        const day = String(dateObj.getUTCDate()).padStart(2, '0');
        const hours = String(dateObj.getUTCHours()).padStart(2, '0');
        const minutes = String(dateObj.getUTCMinutes()).padStart(2, '0');
        const seconds = String(dateObj.getUTCSeconds()).padStart(2, '0');
        
        return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
    }

    async collectBandwidthData() {
        try {
            console.log('🔄 Starting bandwidth data collection...');
            // Refresh proxy targets to ensure latest grouping and IP list
            const liveIps = await this.proxyService.refreshTargets();
            const liveIpList = Array.isArray(liveIps) ? liveIps : this.proxyService.getTargets();
            console.log(`📡 Found ${liveIpList.length} live IPs`);

            const response = await axios.get(this.bandwidthApiUrl, { timeout: 10000 });
            const bandwidthData = response.data;
            console.log(`📊 Fetched ${bandwidthData.length} entries from bandwidth API`);

            const measurements = [];

            const targetsByPort = new Map();
            (this.proxyService.config?.PROXY_PORTS || []).forEach(port => {
                targetsByPort.set(Number(port), new Set(this.proxyService.getTargetsForPort(port) || []));
            });

            bandwidthData.forEach(item => {
                const ip = item.ip;
                if (!liveIpList.includes(ip)) {
                    return;
                }

                const group = this.proxyService.getGroupForIp(ip);
                if (!group) {
                    console.warn(`⚠️ Unable to resolve group for IP ${ip}, skipping`);
                    return;
                }

                const ports = this.proxyService.getPortsForGroup(group);
                if (!ports || ports.length === 0) {
                    console.warn(`⚠️ No ports configured for group ${group}, skipping IP ${ip}`);
                    return;
                }

                const upBandwidth = parseFloat(item.up_bandwidth) || 0;

                ports.forEach(port => {
                    const portNumber = Number(port);
                    const portTargets = targetsByPort.get(portNumber);
                    if (!portTargets || !portTargets.has(ip)) {
                        return;
                    }

                    measurements.push({
                        ip,
                        proxy_port: portNumber,
                        up_bandwidth: upBandwidth
                    });
                });
            });

            console.log(`✅ Prepared ${measurements.length} bandwidth measurements across ports`);

            if (measurements.length > 0) {
                await this.saveToDatabase(measurements);
                console.log(`💾 Saved ${measurements.length} bandwidth measurements`);
            }

            return {
                success: true,
                collected: measurements.length,
                totalLiveIPs: liveIpList.length
            };

        } catch (error) {
            console.error('❌ Error collecting bandwidth data:', error.message);
            return {
                success: false,
                error: error.message
            };
        }
    }

    async saveToDatabase(data) {
        if (!data || data.length === 0) return 0;

        let successfulInserts = 0;
        const query = `INSERT INTO bandwidth_measurements (ip_address, proxy_port, up_bandwidth, timestamp) VALUES (?, ?, ?, UTC_TIMESTAMP())`;

        for (const item of data) {
            try {
                await this.databaseService.db.execute(query, [item.ip, item.proxy_port, item.up_bandwidth]);
                successfulInserts++;
            } catch (error) {
                console.error(`⚠️ Failed to insert ${item.ip}:`, error.message);
            }
        }

        console.log(`💾 Successfully inserted ${successfulInserts}/${data.length} records`);
        return successfulInserts;
    }

    async getIPsBatch(offset = 0, limit = 6, startDate = null, endDate = null, proxyPort = null) {
        try {
            if (!proxyPort) {
                throw new Error('proxyPort is required to fetch IP batch');
            }

            let liveIpsSet = new Set(this.proxyService.getTargetsForPort(proxyPort) || []);
            if (liveIpsSet.size === 0) {
                await this.proxyService.refreshTargets();
                liveIpsSet = new Set(this.proxyService.getTargetsForPort(proxyPort) || []);
            }

            let dateFilter = '';
            const dateParams = [];

            if (startDate && endDate && startDate.trim() !== '' && endDate.trim() !== '') {
                const startTimeStr = this.formatToMySQLTimestamp(startDate);
                const endTimeStr = this.formatToMySQLTimestamp(endDate);

                if (startTimeStr && endTimeStr) {
                    dateFilter = ` AND timestamp BETWEEN ? AND ?`;
                    dateParams.push(startTimeStr, endTimeStr);
                }
            }

            const statsQuery = `
                SELECT 
                    ip_address,
                    AVG(up_bandwidth) as avg_bandwidth,
                    COUNT(*) as measurement_count
                FROM bandwidth_measurements
                WHERE proxy_port = ?${dateFilter}
                GROUP BY ip_address
            `;

            const statsParams = [proxyPort, ...dateParams];
            const [statsRows] = await this.databaseService.db.execute(statsQuery, statsParams);

            const statsMap = new Map();
            statsRows.forEach(row => {
                statsMap.set(row.ip_address, {
                    avgBandwidth: parseFloat(row.avg_bandwidth) || 0,
                    measurementCount: parseInt(row.measurement_count, 10) || 0
                });
            });

            const historicalIps = statsRows.map(row => row.ip_address);
            const allIps = new Set([...historicalIps, ...liveIpsSet]);

            const sortedIpsArray = Array.from(allIps);

            if (sortedIpsArray.length === 0) {
                return {
                    ips: [],
                    ipDetails: {},
                    pagination: {
                        offset: 0,
                        limit: Math.max(1, parseInt(limit, 10) || 6),
                        total: 0,
                        hasMore: false
                    }
                };
            }

            const sortedIps = sortedIpsArray.sort((a, b) => {
                const aStats = statsMap.get(a)?.avgBandwidth || 0;
                const bStats = statsMap.get(b)?.avgBandwidth || 0;
                return bStats - aStats;
            });

            const startIndex = Math.max(0, parseInt(offset, 10) || 0);
            const pageSize = Math.max(1, parseInt(limit, 10) || 6);
            const paginatedIps = sortedIps.slice(startIndex, startIndex + pageSize);

            const ipDetails = {};
            sortedIps.forEach(ip => {
                const groupKey = this.proxyService.getGroupForIp(ip);
                ipDetails[ip] = {
                    avgBandwidth: statsMap.get(ip)?.avgBandwidth || 0,
                    measurementCount: statsMap.get(ip)?.measurementCount || 0,
                    isLive: liveIpsSet.has(ip),
                    group: groupKey || null,
                    groupLabel: groupKey ? this.proxyService.getGroupLabel(groupKey) : (liveIpsSet.has(ip) ? 'Current' : 'Unknown')
                };
            });

            return {
                ips: paginatedIps,
                ipDetails,
                pagination: {
                    offset: startIndex,
                    limit: pageSize,
                    total: sortedIps.length,
                    hasMore: startIndex + pageSize < sortedIps.length
                }
            };

        } catch (error) {
            console.error('❌ Error getting bandwidth IPs:', error.message);
            throw error;
        }
    }

    async getBandwidthData(ip, proxyPort, limit = 1400, startDate = null, endDate = null) {
        try {
            if (!proxyPort) {
                throw new Error('proxyPort is required');
            }

            let query = `
                SELECT up_bandwidth, timestamp 
                FROM bandwidth_measurements 
                WHERE ip_address = ?
                  AND proxy_port = ?
            `;
            const params = [ip, proxyPort];

            // Only add date filter if both dates are provided and valid
            // Convert ISO strings to MySQL TIMESTAMP format
            if (startDate && endDate && startDate.trim() !== '' && endDate.trim() !== '') {
                const startTimeStr = this.formatToMySQLTimestamp(startDate);
                const endTimeStr = this.formatToMySQLTimestamp(endDate);
                
                if (startTimeStr && endTimeStr) {
                    query += ` AND timestamp BETWEEN ? AND ?`;
                    params.push(startTimeStr, endTimeStr);
                }
            }

            query += ` ORDER BY timestamp DESC LIMIT ?`;
            params.push((parseInt(limit) || 1400).toString());

            const [rows] = await this.databaseService.db.execute(query, params);
            return rows.reverse().map(row => ({
                bandwidth: parseFloat(row.up_bandwidth),
                timestamp: row.timestamp
            }));

        } catch (error) {
            console.error('❌ Error getting bandwidth data:', error.message);
            throw error;
        }
    }

    async getBandwidthDataByGroup(groupKey, limit = 1400, startDate = null, endDate = null) {
        try {
            if (!groupKey) {
                return [];
            }

            const ips = this.proxyService.getTargetsForGroup(groupKey);
            if (!ips || ips.length === 0) {
                console.log(`⚠️ No IPs available for group ${groupKey}`);
                return [];
            }

            const placeholders = ips.map(() => '?').join(',');
            const params = [...ips];

            let query = `
                SELECT 
                    timestamp,
                    AVG(up_bandwidth) as avg_bandwidth,
                    COUNT(*) as measurement_count
                FROM bandwidth_measurements
                WHERE ip_address IN (${placeholders})
            `;

            if (startDate && endDate && startDate.trim() !== '' && endDate.trim() !== '') {
                const startTimeStr = this.formatToMySQLTimestamp(startDate);
                const endTimeStr = this.formatToMySQLTimestamp(endDate);

                if (startTimeStr && endTimeStr) {
                    query += ` AND timestamp BETWEEN ? AND ?`;
                    params.push(startTimeStr, endTimeStr);
                }
            }

            query += ` GROUP BY timestamp ORDER BY timestamp DESC LIMIT ?`;
            params.push((parseInt(limit, 10) || 1400).toString());

            const [rows] = await this.databaseService.db.execute(query, params);

            return rows.reverse().map(row => ({
                bandwidth: parseFloat(row.avg_bandwidth) || 0,
                timestamp: row.timestamp,
                measurementCount: parseInt(row.measurement_count, 10) || 0
            }));

        } catch (error) {
            console.error('❌ Error getting bandwidth data by group:', error.message);
            throw error;
        }
    }

    async getTotalIPsCount() {
        try {
            const query = `SELECT COUNT(DISTINCT ip_address) as total FROM bandwidth_measurements`;
            const [rows] = await this.databaseService.db.execute(query);
            return rows[0].total;
        } catch (error) {
            console.error('❌ Error getting total IPs count:', error.message);
            return 0;
        }
    }
}

module.exports = BandwidthService;