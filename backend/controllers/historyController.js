const DatabaseService = require('../services/databaseService');

class HistoryController {
    constructor(databaseService, proxyService) {
        this.databaseService = databaseService;
        this.proxyService = proxyService;
    }

    async getChartData(req, res) {
        try {
            console.time("getChartData");
            const {
                proxyPort = '10220',
                period = '24h',
                company = ''  // Remove page and pageSize parameters
            } = req.query;

            const proxyPortNum = parseInt(proxyPort, 10);

            if (isNaN(proxyPortNum)) {
                return res.status(400).json({
                    success: false,
                    error: 'Invalid proxy port'
                });
            }

            console.log(`📊 Generating chart data for proxy ${proxyPortNum}, period: ${period}, company: ${company || 'All'}`);

            // Calculate time range and segment size
            const { startTime, endTime, segmentCount, segmentSizeMs } = this.calculateTimeRangeAndSegments(period);

            console.time("getIPList");
            // Get live IPs for sorting
            const liveIPs = await this.proxyService.getIPList();
            console.log(`📍 Live IPs: ${liveIPs.length} IPs`);
            console.timeEnd("getIPList");

            // Use new smart data generation WITHOUT pagination
            const chartData = await this.generateSmartChartData(
                proxyPortNum,
                startTime,
                endTime,
                segmentCount,
                segmentSizeMs,
                liveIPs,
                period,
                company
            );

            res.json({
                success: true,
                period,
                proxyPort: proxyPortNum,
                companyFilter: company,
                chartData: chartData,
                totalTargets: chartData.series.length, // Now showing all targets
                liveIPsCount: liveIPs.length,
                generatedAt: new Date().toISOString()
            });

        } catch (error) {
            console.error('❌ Error in getChartData:', error.message);
            res.status(500).json({
                success: false,
                error: 'Failed to generate chart data',
                details: error.message
            });
        } finally {
            console.timeEnd("getChartData");
        }
    }
    async generateSmartChartData(proxyPort, startTime, endTime, segmentCount, segmentSizeMs, liveIPs, period, companyFilter = '') {
        try {
            console.time("SmartChartData");
            console.log('🚀 Starting smart chart data generation...');

            // STEP 1: Use the new smart function to get ALL data sorted by RTT
            console.time('GetSmartRangeData');
            const chartSeries = await this.databaseService.getRangeMeasurementsSmart(
                proxyPort, startTime, endTime, segmentCount, segmentSizeMs, liveIPs, companyFilter
            );
            console.timeEnd('GetSmartRangeData');
            console.log(`📊 Smart query returned ${chartSeries.length} IPs`);

            // STEP 2: Get company info for all IPs
            const allIPs = chartSeries.map(ipInfo => ipInfo.target_host);
            const companyInfo = await this.databaseService.getCompanyFromCache(allIPs);
            console.log(`🏢 Got company info for ${Object.keys(companyInfo).length} IPs`);

            // STEP 3: Prepare response
            const timePoints = this.generateTimePoints(startTime, endTime, segmentCount, segmentSizeMs, period);

            console.timeEnd("SmartChartData");

            return {
                timePoints,
                series: chartSeries, // Already sorted by RTT with live IPs first
                segmentSizeMs,
                segmentCount,
                totalTargets: chartSeries.length,
                companies: companyInfo,
                distinctCompanies: this.getDistinctCompanies(companyInfo),
                distinctCountries: this.getDistinctCountries(companyInfo)
            };

        } catch (error) {
            console.error('❌ Error in smart chart data generation:', error.message);
            throw error;
        }
    }
    // ADD THIS MISSING METHOD:
    async generateRangeChartData(proxyPort, startTime, endTime, segmentCount, segmentSizeMs, liveIPs, period, page, pageSize, companyFilter = '') {
        try {
            console.time("SmartChartData");
            console.log('🚀 Starting smart chart data generation...');

            // STEP 1: Get historical IPs with last inserted time
            console.time('GetHistoricalIPs');
            const historicalIPs = await this.databaseService.getHistoricalIPsWithTime(proxyPort, startTime, endTime);
            console.timeEnd('GetHistoricalIPs');
            console.log(`📊 Found ${historicalIPs.length} historical IPs`);

            // STEP 2: Get company info with caching
            const allIPs = [...new Set([...liveIPs, ...historicalIPs.map(ip => ip.target_host)])];
            const companyInfo = await this.databaseService.getCompanyFromCache(allIPs);
            console.log(`🏢 Got company info for ${Object.keys(companyInfo).length} IPs`);

            // STEP 3: Combine IP data with company info and prioritize
            const prioritizedIPs = this.prioritizeIPs(liveIPs, historicalIPs, companyInfo, companyFilter, page, pageSize);
            console.log(`🎯 Selected ${prioritizedIPs.length} IPs for display`);

            // STEP 4: Get chart data for selected IPs only
            console.time('GetChartDataForIPs');
            const chartData = await this.databaseService.getChartDataForIPs( // Use databaseService directly
                proxyPort, startTime, endTime, segmentCount, segmentSizeMs,
                prioritizedIPs, period
            );
            console.timeEnd('GetChartDataForIPs');

            // STEP 5: Prepare response
            const timePoints = this.generateTimePoints(startTime, endTime, segmentCount, segmentSizeMs, period);

            console.timeEnd("SmartChartData");

            return {
                timePoints,
                series: chartData,
                segmentSizeMs,
                segmentCount,
                totalTargets: prioritizedIPs.totalCount || prioritizedIPs.length,
                totalPages: Math.ceil((prioritizedIPs.totalCount || prioritizedIPs.length) / pageSize),
                currentPage: page,
                companies: companyInfo,
                distinctCompanies: this.getDistinctCompanies(companyInfo),
                distinctCountries: this.getDistinctCountries(companyInfo)
            };

        } catch (error) {
            console.error('❌ Error in smart chart data generation:', error.message);
            throw error;
        }
    }

    calculateTimeRangeAndSegments(period) {
        const endTime = new Date();
        let startTime = new Date();
        let segmentCount = 100;

        switch (period) {
            case '6h':
                startTime.setTime(endTime.getTime() - (6 * 60 * 60 * 1000));
                break;
            case '24h':
                startTime.setTime(endTime.getTime() - (24 * 60 * 60 * 1000));
                break;
            case '7d':
                startTime.setTime(endTime.getTime() - (7 * 24 * 60 * 60 * 1000));
                break;
            case '30d':
                startTime.setTime(endTime.getTime() - (30 * 24 * 60 * 60 * 1000));
                break;
            default:
                startTime.setTime(endTime.getTime() - (24 * 60 * 60 * 1000));
        }

        const totalTimeMs = endTime - startTime;
        const segmentSizeMs = totalTimeMs / segmentCount;

        console.log(`⏰ Time Range - Start: ${startTime.toISOString()}, End: ${endTime.toISOString()}`);
        console.log(`📊 Total time: ${totalTimeMs}ms, Segment size: ${segmentSizeMs}ms`);

        return { startTime, endTime, segmentCount, segmentSizeMs };
    }



    getColorForIP(targetHost, liveIPs) {
        return liveIPs.includes(targetHost) ? '#3b82f6' : '#6b7280';
    }

    formatSegmentLabel(start, end, period) {
        const startDate = new Date(start);
        const endDate = new Date(end);

        if (period === '24h' || period === '6h') {
            return startDate.toLocaleTimeString('en-US', {
                hour: '2-digit',
                minute: '2-digit',
                hour12: false,
                timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
            });
        } else {
            return startDate.toLocaleDateString('en-US', {
                month: 'short',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
                timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
            });
        }
    }

    // FIXED searchIP method
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
            const { startTime, endTime } = this.calculateTimeRangeAndSegments(period);

            // Search for IP in database - USE databaseService
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
                startTime,  // FIXED: Use startTime directly, not startTime.startTime
                endTime     // FIXED: Use endTime directly, not startTime.endTime
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
    prioritizeIPs(liveIPs, historicalIPs, companyInfo, companyFilter, page, pageSize) {
        // Combine all IP data
        const allIPData = [];

        // Add live IPs with high priority
        liveIPs.forEach(ip => {
            const historicalData = historicalIPs.find(h => h.target_host === ip);
            allIPData.push({
                ip,
                isLive: true,
                lastInsertedTime: historicalData ? historicalData.last_inserted_time : new Date(0),
                measurementCount: historicalData ? historicalData.measurement_count : 0,
                company: companyInfo[ip]?.company || 'Unknown'
            });
        });

        // Add historical IPs (non-live)
        historicalIPs
            .filter(h => !liveIPs.includes(h.target_host))
            .forEach(historical => {
                allIPData.push({
                    ip: historical.target_host,
                    isLive: false,
                    lastInsertedTime: historical.last_inserted_time,
                    measurementCount: historical.measurement_count,
                    company: companyInfo[historical.target_host]?.company || 'Unknown'
                });
            });

        // Apply company filter
        let filteredIPs = allIPData;
        if (companyFilter && companyFilter !== '') {
            filteredIPs = allIPData.filter(ipData =>
                ipData.company.toLowerCase().includes(companyFilter.toLowerCase())
            );
        }

        // Sort: Live IPs first, then by last inserted time (newest first)
        filteredIPs.sort((a, b) => {
            if (a.isLive && !b.isLive) return -1;
            if (!a.isLive && b.isLive) return 1;
            return new Date(b.lastInsertedTime) - new Date(a.lastInsertedTime);
        });

        // Apply pagination
        const startIndex = (page - 1) * pageSize;
        const paginatedIPs = filteredIPs.slice(startIndex, startIndex + pageSize);

        console.log(`📄 Pagination: Page ${page}, Size ${pageSize}, Showing ${paginatedIPs.length} of ${filteredIPs.length} IPs`);

        // Return IP strings for chart query
        return paginatedIPs.map(ipData => ipData.ip);
    }

    async getCompanyInfoWithCache(ipList) {
        // This will use the DatabaseService method we created
        return await this.databaseService.getCompanyInfoWithCache(ipList);
    }
    generateTimePoints(startTime, endTime, segmentCount, segmentSizeMs, period) {
        const timePoints = [];
        for (let i = 0; i < segmentCount; i++) {
            const segmentStart = new Date(startTime.getTime() + (i * segmentSizeMs));
            const segmentEnd = new Date(segmentStart.getTime() + segmentSizeMs);
            timePoints.push({
                start: segmentStart.toISOString(),
                end: segmentEnd.toISOString(),
                label: this.formatSegmentLabel(segmentStart, segmentEnd, period),
                segmentIndex: i
            });
        }
        return timePoints;
    }

    getDistinctCompanies(companyInfo) {
        const companies = [...new Set(
            Object.values(companyInfo)
                .filter(info => info.found && info.company && info.company !== 'Unknown')
                .map(info => info.company)
        )].sort();

        return companies.map(company => ({
            name: company,
            country: 'Unknown'
        }));
    }


    // Get distinct countries
    getDistinctCountries(companyInfo) {
        return [...new Set(
            Object.values(companyInfo)
                .filter(info => info.found && info.country && info.country !== 'Unknown')
                .map(info => info.country)
        )].sort();
    }



}

module.exports = HistoryController;