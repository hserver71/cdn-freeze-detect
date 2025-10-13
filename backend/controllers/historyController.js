const DatabaseService = require('../services/databaseService');

class HistoryController {
    constructor(databaseService) {
        this.databaseService = databaseService;
    }

    async getChartData(req, res) {
        try {
            const {
                proxyPort = '10220',
                period = '24h',
                targetIps = ''
            } = req.query;

            const proxyPortNum = parseInt(proxyPort, 10);

            if (isNaN(proxyPortNum)) {
                return res.status(400).json({
                    success: false,
                    error: 'Invalid proxy port'
                });
            }

            console.log(`📊 Generating chart data for proxy ${proxyPortNum}, period: ${period}`);

            // Calculate time range based on period
            const { startTime, endTime, pointCount } = this.calculateTimeRange(period);

            // Get all targets for this proxy port
            const allTargets = await this.databaseService.getDistinctTargets(proxyPortNum);

            // Smart IP selection (10 IPs: 4 high, 3 medium, 3 low RTT)
            const selectedIps = await this.selectSmartIPs(allTargets, proxyPortNum, startTime, endTime, req.query.chartType);

            // Generate chart data for selected IPs
            const chartData = await this.generateChartData(selectedIps, proxyPortNum, startTime, endTime, pointCount);

            res.json({
                success: true,
                period,
                proxyPort: proxyPortNum,
                selectedIps: selectedIps.map(ip => ({
                    ip: ip.ip,
                    category: ip.category,
                    avgRtt: ip.avgRtt,
                    errorRate: ip.errorRate
                })),
                chartData,
                totalTargets: allTargets.length,
                generatedAt: new Date().toISOString()
            });

        } catch (error) {
            console.error('❌ Error in getChartData:', error.message);
            res.status(500).json({
                success: false,
                error: 'Failed to generate chart data',
                details: error.message
            });
        }
    }

    calculateTimeRange(period) {
        const endTime = new Date();
        let startTime = new Date();
        let pointCount = 100;

        switch (period) {
            case '6h':
                startTime.setHours(endTime.getHours() - 6);
                pointCount = 100;
                break;
            case '24h':
                startTime.setHours(endTime.getHours() - 24);
                pointCount = 100;
                break;
            case '7d':
                startTime.setDate(endTime.getDate() - 7);
                pointCount = 100;
                break;
            case '30d':
                startTime.setDate(endTime.getDate() - 30);
                pointCount = 100;
                break;
            default:
                startTime.setHours(endTime.getHours() - 24); // Default 24h
        }

        return { startTime, endTime, pointCount };
    }

    async selectSmartIPs(allTargets, proxyPort, startTime, endTime, chartType = 'line'){
        if (chartType === 'heatmap') {
            // For heatmap, return ALL targets
            const ipsWithStats = await Promise.all(
                allTargets.map(async (target) => {
                    try {
                        const stats = await this.databaseService.getTargetStats(
                            target.target_host,
                            target.target_port,
                            proxyPort,
                            startTime,
                            endTime
                        );
                        return { ...target, ...stats };
                    } catch (error) {
                        console.error(`Error getting stats for ${target.target_host}:`, error.message);
                        return {
                            ...target,
                            avgRtt: null,
                            totalMeasurements: 0,
                            errorCount: 0,
                            errorRate: 0
                        };
                    }
                })
            );

            // Sort by IP for consistent display
            return ipsWithStats.sort((a, b) =>
                a.target_host.localeCompare(b.target_host)
            );
        }
        if (allTargets.length <= 10) {
            // If we have 10 or fewer targets, return all with categories
            const ipsWithStats = await Promise.all(
                allTargets.map(async (target) => {
                    const stats = await this.databaseService.getTargetStats(
                        target.target_host,
                        target.target_port,
                        proxyPort,
                        startTime,
                        endTime
                    );
                    return { ...target, ...stats };
                })
            );

            return this.categorizeIPs(ipsWithStats);
        }

        // For many targets, get stats for all and select top 10
        const ipsWithStats = await Promise.all(
            allTargets.map(async (target) => {
                const stats = await this.databaseService.getTargetStats(
                    target.target_host,
                    target.target_port,
                    proxyPort,
                    startTime,
                    endTime
                );
                return { ...target, ...stats };
            })
        );

        // Sort by average RTT and error rate
        const sortedIPs = ipsWithStats.sort((a, b) => {
            // Prioritize IPs with high RTT and high error rate
            const scoreA = (a.avgRtt || 0) + (a.errorRate * 1000);
            const scoreB = (b.avgRtt || 0) + (b.errorRate * 1000);
            return scoreB - scoreA;
        });

        // Take top 10 and categorize
        const top10 = sortedIPs.slice(0, 10);
        return this.categorizeIPs(top10);
    }

    categorizeIPs(ips) {
        const sortedByRtt = ips.filter(ip => ip.avgRtt !== null)
            .sort((a, b) => b.avgRtt - a.avgRtt);

        const result = [];

        // High RTT (4 IPs)
        const highRtt = sortedByRtt.slice(0, 4);
        highRtt.forEach(ip => result.push({ ...ip, category: 'high' }));

        // Medium RTT (3 IPs)
        const mediumRtt = sortedByRtt.slice(4, 7);
        mediumRtt.forEach(ip => result.push({ ...ip, category: 'medium' }));

        // Low RTT (3 IPs) - take from the end
        const lowRtt = sortedByRtt.slice(-3);
        lowRtt.forEach(ip => result.push({ ...ip, category: 'low' }));

        return result;
    }

    async generateChartData(selectedIps, proxyPort, startTime, endTime, pointCount) {
        const intervalMs = (endTime - startTime) / pointCount;

        const chartData = {
            timePoints: [],
            series: []
        };

        // Generate time points
        for (let i = 0; i < pointCount; i++) {
            const timePoint = new Date(startTime.getTime() + (i * intervalMs));
            chartData.timePoints.push(timePoint.toISOString());
        }

        // Get data for each IP
        for (const ipInfo of selectedIps) {
            const ipData = {
                ip: `${ipInfo.target_host}:${ipInfo.target_port}`,
                category: ipInfo.category,
                color: this.getColorForCategory(ipInfo.category),
                data: []
            };

            for (const timePoint of chartData.timePoints) {
                const pointTime = new Date(timePoint);
                const searchWindow = 7.2 * 60 * 1000; // ±7.2 minutes in ms

                const nearestData = await this.databaseService.getNearestMeasurement(
                    ipInfo.target_host,
                    ipInfo.target_port,
                    proxyPort,
                    pointTime,
                    searchWindow
                );

                if (nearestData) {
                    ipData.data.push({
                        timestamp: nearestData.created_at,
                        rtt: nearestData.rtt_ms,
                        status: nearestData.status,
                        isExact: Math.abs(new Date(nearestData.created_at) - pointTime) < 60000 // within 1 minute
                    });
                } else {
                    // No data found in search window
                    ipData.data.push({
                        timestamp: timePoint,
                        rtt: null,
                        status: 'no_data',
                        isExact: false
                    });
                }
            }

            chartData.series.push(ipData);
        }

        return chartData;
    }

    getColorForCategory(category) {
        switch (category) {
            case 'high': return '#dc2626';    // Red
            case 'medium': return '#f97316';  // Orange  
            case 'low': return '#22c55e';     // Green
            default: return '#6b7280';        // Gray
        }
    }
    async searchIP(req, res) {
        try {
            const {
                proxyPort = '10220',
                ip,
                period = '24h'
            } = req.query;

            const proxyPortNum = parseInt(proxyPort, 10);

            if (isNaN(proxyPortNum) || !ip) {
                return res.status(400).json({
                    success: false,
                    error: 'Invalid parameters'
                });
            }

            console.log(`🔍 Searching for IP: ${ip} in proxy ${proxyPortNum}`);

            // Calculate time range
            const { startTime, endTime } = this.calculateTimeRange(period);

            // Search for IP in database
            const query = `
      SELECT DISTINCT target_host, target_port 
      FROM measurements 
      WHERE proxy_port = ? 
        AND (target_host LIKE ? OR CONCAT(target_host, ':', target_port) LIKE ?)
        AND created_at BETWEEN ? AND ?
      LIMIT 1
    `;

            const [rows] = await this.databaseService.db.execute(query, [
                proxyPortNum,
                `%${ip}%`,
                `%${ip}%`,
                startTime,
                endTime
            ]);

            if (rows.length > 0) {
                const foundIP = `${rows[0].target_host}:${rows[0].target_port}`;
                res.json({
                    success: true,
                    found: true,
                    ip: foundIP,
                    message: `IP ${foundIP} found`
                });
            } else {
                res.json({
                    success: true,
                    found: false,
                    message: `IP ${ip} not found in the selected period`
                });
            }

        } catch (error) {
            console.error('❌ Error searching IP:', error.message);
            res.status(500).json({
                success: false,
                error: 'Failed to search IP',
                details: error.message
            });
        }
    }
}

module.exports = HistoryController;