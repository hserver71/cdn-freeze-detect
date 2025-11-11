const DatabaseService = require('./databaseService');
const IPInfoService = require('./ipInfoService');
const IPUtils = require('../utils/ipUtils');
class CacheService {
    constructor(databaseService) {
        this.databaseService = databaseService;
        this.isRunning = false;
        this.lastRun = null;
        this.nextRun = null;
    }

    // Main cache update method
    async updateCompanyCache() {
        if (this.isRunning) {
            console.log('⏳ Cache update already in progress, skipping...');
            return;
        }

        this.isRunning = true;
        const startTime = Date.now();

        try {
            console.log('🔄 Starting company cache update with binary search...');

            // STEP 1: Pre-load IP ranges for binary search
            console.time('LoadIPRanges');
            const rangesCount = await IPInfoService.loadIPRangesForBinarySearch();
            console.timeEnd('LoadIPRanges');
            console.log(`📊 Loaded ${rangesCount} IP ranges for binary search`);

            // STEP 2: Get ALL historical IPs
            console.time('GetAllHistoricalIPs');
            const historicalIPs = await this.getAllHistoricalIPs();
            console.timeEnd('GetAllHistoricalIPs');
            console.log(`📊 Found ${historicalIPs.length} historical IPs`);

            // STEP 3: Use REAL binary search to find companies
            console.time('BinarySearchProcessing');
            const companyInfo = await IPInfoService.getCompaniesForIPsWithBinarySearch(historicalIPs);
            console.timeEnd('BinarySearchProcessing');

            // STEP 4: Save to cache
            console.time('SaveToCache');
            await this.saveToCache(companyInfo);
            console.timeEnd('SaveToCache');

            // STEP 5: Update timestamps
            this.lastRun = new Date();
            this.nextRun = new Date(Date.now() + 10 * 60 * 1000);

            const duration = Date.now() - startTime;
            console.log(`✅ Company cache updated with binary search in ${duration}ms`);
            console.log(`⏰ Next update: ${this.nextRun.toLocaleTimeString()}`);

        } catch (error) {
            console.error('❌ Error updating company cache with binary search:', error.message);
        } finally {
            this.isRunning = false;
        }
    }

    // Get ALL historical IPs from measurements table
    async getAllHistoricalIPs() {
        try {
            const query = `
                SELECT DISTINCT target_host as ip
                FROM measurements 
                WHERE target_host IS NOT NULL 
                AND target_host != ''
                AND target_host NOT LIKE '%:%' -- Exclude IPv6 for now
                ORDER BY target_host
            `;

            const [rows] = await this.databaseService.db.execute(query);
            return rows.map(row => row.ip);
        } catch (error) {
            console.error('❌ Error getting historical IPs:', error.message);
            return [];
        }
    }

    // Process IPs with binary search algorithm
    async processIPsWithBinarySearch(ipList) {
        try {
            const batchSize = 1000;
            let processedCount = 0;
            let savedCount = 0;
            let unknownCount = 0;

            console.log(`🔄 Processing ${ipList.length} IPs in batches of ${batchSize}...`);

            for (let i = 0; i < ipList.length; i += batchSize) {
                const batch = ipList.slice(i, i + batchSize);
                processedCount += batch.length;

                // STEP 1: Check which IPs are already in cache
                const placeholders = batch.map(() => '?').join(',');
                const cacheQuery = `SELECT ip FROM ip_company_cache WHERE ip IN (${placeholders})`;
                const [cachedIPs] = await this.databaseService.db.execute(cacheQuery, batch);

                const cachedIPSet = new Set(cachedIPs.map(row => row.ip));
                const ipsToProcess = batch.filter(ip => !cachedIPSet.has(ip));

                console.log(`📦 Batch ${Math.floor(i / batchSize) + 1}: ${ipsToProcess.length} new IPs to process`);

                if (ipsToProcess.length === 0) {
                    continue;
                }

                // STEP 2: Get company info using binary search
                const companyInfo = await IPInfoService.getCompaniesForIPs(ipsToProcess);

                // STEP 3: Save to cache (company or "Unknown")
                const savePromises = [];

                for (const ip of ipsToProcess) {
                    const info = companyInfo[ip] || {};

                    if (info.found && info.company && info.company !== 'Unknown') {
                        // Save actual company info
                        savePromises.push(
                            this.databaseService.saveToCompanyCache(
                                ip,
                                info.company,
                                info.country || 'Unknown',
                                info.asn || 'Unknown'
                            )
                        );
                        savedCount++;
                    } else {
                        // Save as "Unknown"
                        savePromises.push(
                            this.databaseService.saveToCompanyCache(
                                ip,
                                'Unknown',
                                'Unknown',
                                'Unknown'
                            )
                        );
                        unknownCount++;
                    }
                }

                // Wait for batch to complete
                await Promise.all(savePromises);

                console.log(`💾 Batch ${Math.floor(i / batchSize) + 1}: Saved ${savedCount} companies, ${unknownCount} unknowns`);

                // Small delay to prevent database overload
                if (i + batchSize < ipList.length) {
                    await new Promise(resolve => setTimeout(resolve, 100));
                }
            }

            console.log(`🎯 Cache update complete: ${processedCount} IPs processed, ${savedCount} companies, ${unknownCount} unknowns`);

        } catch (error) {
            console.error('❌ Error processing IPs with binary search:', error.message);
            throw error;
        }
    }

    // Start the cron-like scheduler
    startScheduler() {
        console.log('⏰ Starting cache scheduler with binary search (runs every 10 minutes)...');

        // Run immediately on startup
        this.updateCompanyCache();

        // Then run every 10 minutes
        setInterval(() => {
            this.updateCompanyCache();
        }, 10 * 60 * 1000);
    }

    // Get cache status
    getStatus() {
        const stats = IPInfoService.getBinarySearchStats();
        return {
            isRunning: this.isRunning,
            lastRun: this.lastRun,
            nextRun: this.nextRun,
            status: this.isRunning ? 'running' : 'idle',
            binarySearch: stats
        };
    }

    async saveToCache(companyInfo) {
        try {
            let savedCount = 0;
            let unknownCount = 0;
            const batchSize = 500;

            const ips = Object.keys(companyInfo);
            console.log(`💾 Saving ${ips.length} IPs to cache...`);

            for (let i = 0; i < ips.length; i += batchSize) {
                const batch = ips.slice(i, i + batchSize);
                const savePromises = [];

                for (const ip of batch) {
                    const info = companyInfo[ip];
                    const ipNumericString = IPUtils.ip2numericString(ip); // Get string version

                    if (info.found && info.company && info.company !== 'Unknown') {
                        savePromises.push(
                            this.databaseService.saveToCompanyCache(
                                ip,
                                info.company,
                                info.country || 'Unknown',
                                info.asn || 'Unknown',
                                ipNumericString // Pass as string
                            )
                        );
                        savedCount++;
                    } else {
                        savePromises.push(
                            this.databaseService.saveToCompanyCache(
                                ip,
                                'Unknown',
                                'Unknown',
                                'Unknown',
                                ipNumericString // Pass as string
                            )
                        );
                        unknownCount++;
                    }
                }

                await Promise.all(savePromises);

                if (i % 5000 === 0 || i + batchSize >= ips.length) {
                    console.log(`📦 Cache save progress: ${Math.min(i + batchSize, ips.length)}/${ips.length}`);
                }

                // Small delay to prevent database overload
                if (i + batchSize < ips.length) {
                    await new Promise(resolve => setTimeout(resolve, 50));
                }
            }

            console.log(`💾 Cache save complete: ${savedCount} companies, ${unknownCount} unknowns`);
        } catch (error) {
            console.error('❌ Error saving to cache:', error.message);
        }
    }
}

module.exports = CacheService;