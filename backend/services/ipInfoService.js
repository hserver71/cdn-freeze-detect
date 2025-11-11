const IPUtils = require('../utils/ipUtils');

class IPInfoService {
    constructor() {
        this.db = null;
        this.isInitialized = false;
        this.ipRanges = []; // For binary search
        this.isRangesLoaded = false;
    }

    setDatabase(db) {
        this.db = db;
        this.isInitialized = true;
        console.log('✅ IPInfoService database connection established');
    }

    async loadIPRangesFromCSV(filePath) {
        try {
            if (!this.isInitialized) {
                throw new Error('IPInfoService not initialized. Call setDatabase() first.');
            }

            const fs = require('fs');
            const path = require('path');

            const csvPath = path.resolve(process.cwd(), filePath);
            console.log(`📁 Looking for CSV file at: ${csvPath}`);

            if (!fs.existsSync(csvPath)) {
                console.log('❌ CSV file not found');
                return 0;
            }

            console.log(`📁 Reading CSV file from: ${csvPath}`);
            const csvData = fs.readFileSync(csvPath, 'utf8');
            const lines = csvData.split('\n').filter(line => line.trim());

            if (lines.length <= 1) {
                console.log('⚠️  CSV file is empty or has only headers');
                return 0;
            }

            console.log(`📊 Total rows to process: ${lines.length - 1}`);

            // Check if we already have valid data
            const shouldLoad = await this.shouldLoadData();
            if (!shouldLoad) {
                console.log('📊 Valid IP ranges data already exists, skipping reload');
                const stats = await this.getStatistics();
                return stats.totalRanges;
            }

            // Clear existing data
            await this.clearExistingData();

            const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
            const rows = lines.slice(1);

            let loadedCount = 0;
            let errorCount = 0;
            const batchSize = 1000;

            console.log('🔄 Processing IPv4 ranges only...');

            for (let i = 0; i < rows.length; i += batchSize) {
                const batch = rows.slice(i, i + batchSize);
                const values = [];

                for (const line of batch) {
                    try {
                        // FIXED: Use proper CSV parsing that handles quotes and commas in values
                        const rowValues = this.parseCSVLine(line);
                        if (rowValues.length < 4) continue;

                        const row = {};
                        headers.forEach((header, index) => {
                            row[header] = rowValues[index] || '';
                        });

                        const { start_ip, end_ip, asn, name, domain } = row;

                        // Only process IPv4
                        if (!IPUtils.isIPv4(start_ip) || !IPUtils.isIPv4(end_ip)) {
                            continue;
                        }

                        // Use BigInt to handle large numbers safely
                        const startBigInt = IPUtils.ip2bigint(start_ip);
                        const endBigInt = IPUtils.ip2bigint(end_ip);

                        // Validate IP conversion
                        if (!startBigInt || !endBigInt) {
                            errorCount++;
                            continue;
                        }

                        // Validate range order
                        if (startBigInt > endBigInt) {
                            errorCount++;
                            continue;
                        }

                        // Convert BigInt to string for database
                        const startNumericStr = startBigInt.toString();
                        const endNumericStr = endBigInt.toString();

                        // Clean company name - remove quotes and trim
                        const cleanCompany = name ? name.replace(/^"|"$/g, '').trim() : '';
                        const cleanDomain = domain ? domain.replace(/^"|"$/g, '').trim() : '';

                        values.push([
                            startNumericStr,
                            endNumericStr,
                            start_ip,
                            end_ip,
                            asn,
                            cleanCompany,
                            cleanDomain,
                            'ipv4'
                        ]);
                        loadedCount++;

                    } catch (error) {
                        errorCount++;
                        continue;
                    }
                }

                if (values.length > 0) {
                    try {
                        const placeholders = values.map(() => '(?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
                        const flatValues = values.flat();

                        const query = `
                            INSERT IGNORE INTO ip_ranges 
                            (start_ip_numeric, end_ip_numeric, start_ip, end_ip, asn, company, domain, ip_type) 
                            VALUES ${placeholders}
                        `;

                        await this.db.execute(query, flatValues);
                        console.log(`✅ Inserted batch of ${values.length} rows (Total: ${loadedCount})`);
                    } catch (batchError) {
                        console.error('❌ Batch insert failed:', batchError.message);
                        errorCount += values.length;
                    }
                }

                if (i % 5000 === 0 || i + batchSize >= rows.length) {
                    console.log(`📦 Processed ${Math.min(i + batchSize, rows.length)}/${rows.length} rows (Loaded: ${loadedCount}, Errors: ${errorCount})`);
                }
            }

            console.log(`✅ Successfully loaded ${loadedCount} IPv4 ranges into database`);
            if (errorCount > 0) {
                console.log(`⚠️  Skipped ${errorCount} rows due to errors`);
            }

            return loadedCount;

        } catch (error) {
            console.error('❌ Error loading CSV:', error);
            throw error;
        }
    }
    parseCSVLine(line) {
        const result = [];
        let current = '';
        let inQuotes = false;

        for (let i = 0; i < line.length; i++) {
            const char = line[i];
            const nextChar = line[i + 1];

            if (char === '"') {
                if (inQuotes && nextChar === '"') {
                    // Escaped quote inside quotes
                    current += '"';
                    i++; // Skip next quote
                } else {
                    // Toggle quote state
                    inQuotes = !inQuotes;
                }
            } else if (char === ',' && !inQuotes) {
                // Comma outside quotes - end of field
                result.push(current.trim());
                current = '';
            } else {
                // Regular character
                current += char;
            }
        }

        // Add the last field
        result.push(current.trim());

        return result;
    }
    async shouldLoadData() {
        try {
            if (!this.isInitialized) return true;

            // Check if we have sufficient data (more than 300,000 rows)
            const [countResult] = await this.db.execute('SELECT COUNT(*) as count FROM ip_ranges');
            const rowCount = countResult[0].count;

            console.log(`📊 Current IP ranges in database: ${rowCount} rows`);

            // If we have more than 300,000 rows, consider the data sufficient
            if (rowCount > 300000) {
                console.log('✅ Database has sufficient IP ranges, skipping reload');
                return false;
            }

            // If we have some data but less than threshold, validate it
            if (rowCount > 0) {
                const isValid = await this.validateData();
                if (isValid) {
                    console.log(`✅ Existing data is valid (${rowCount} rows), skipping reload`);
                    return false;
                }
                console.log('❌ Existing data is invalid, will reload');
            }

            return true;

        } catch (error) {
            console.error('❌ Error checking existing data:', error);
            return true; // Load data if check fails
        }
    }

    async validateData() {
        try {
            if (!this.isInitialized) {
                return false;
            }

            // Check if we have a reasonable number of rows
            const [countResult] = await this.db.execute('SELECT COUNT(*) as count FROM ip_ranges');
            const rowCount = countResult[0].count;

            if (rowCount === 0) {
                console.log('❌ No data in ip_ranges table');
                return false;
            }

            console.log(`🔍 Testing IP range data with ${rowCount} entries...`);

            // Test a few sample queries to ensure data is usable
            const testIPs = ['8.8.8.8', '1.1.1.1', '192.168.1.1'];
            let successCount = 0;

            for (const testIP of testIPs) {
                try {
                    const info = await this.getIPInfo(testIP);
                    if (info.found) {
                        successCount++;
                        console.log(`✅ ${testIP} → ${info.company} (AS${info.asn})`);
                    } else {
                        console.log(`ℹ️  ${testIP} → Not found in ranges (expected for private IPs)`);
                    }
                } catch (error) {
                    console.warn(`⚠️  Test query failed for ${testIP}:`, error.message);
                }
            }

            const isValid = successCount >= 1; // At least one successful lookup
            console.log(`🔍 Data validation: ${successCount}/${testIPs.length} test queries successful`);

            if (!isValid) {
                console.log('❌ Data validation failed - IP ranges may be incorrect or incomplete');
            }

            return isValid;

        } catch (error) {
            console.error('❌ Error validating data:', error);
            return false;
        }
    }

    async clearExistingData() {
        try {
            await this.db.execute('DELETE FROM ip_ranges');
            console.log('🗑️  Cleared existing IP range data from ip_ranges table');
        } catch (error) {
            console.error('❌ Error clearing existing data:', error);
        }
    }

    async getIPInfo(ip) {
        return this.getCompanyWithBinarySearch(ip);
    }

    // Simple ASN to country mapping (you can expand this)
    mapASNToCountry(asn) {
        const countryMap = {
            'AS15169': 'United States', // Google
            'AS16509': 'United States', // Amazon
            'AS8075': 'United States',  // Microsoft
            'AS32934': 'France',        // Facebook
            'AS4766': 'Korea',          // Korea Telecom
            'AS3786': 'Korea',          // LG Dacom
            // Add more mappings as needed
        };

        return countryMap[asn] || 'Unknown';
    }
    async getIPInfoBatch(ipList) {
        try {
            if (!this.isInitialized) {
                console.warn('⚠️ IPInfoService not initialized, returning default info for batch');
                return ipList.map(ip => this.getDefaultInfo(ip));
            }

            const results = await Promise.all(
                ipList.map(ip => this.getIPInfo(ip))
            );
            return results;
        } catch (error) {
            console.error('❌ Error getting batch IP info:', error);
            return ipList.map(ip => this.getDefaultInfo(ip));
        }
    }

    getDefaultInfo(ip) {
        return {
            ip: ip,
            asn: 'Unknown',
            company: 'Unknown',
            domain: '',
            country: 'Unknown',
            ipType: 'unknown',
            found: false
        };
    }

    async getStatistics() {
        try {
            if (!this.isInitialized) {
                return { totalRanges: 0 };
            }

            const [result] = await this.db.execute('SELECT COUNT(*) as totalRanges FROM ip_ranges');
            return {
                totalRanges: result[0].totalRanges
            };
        } catch (error) {
            console.error('❌ Error getting statistics:', error);
            return { totalRanges: 0 };
        }
    }
    async getBulkIPInfo(ipList) {
        try {
            if (!this.isInitialized || !ipList || ipList.length === 0) {
                return {};
            }

            // Filter valid IPv4 addresses and convert to numeric
            const ipNumericMap = new Map();
            const validIPs = [];

            for (const ip of ipList) {
                if (IPUtils.isIPv4(ip)) {
                    const ipBigInt = IPUtils.ip2bigint(ip);
                    if (ipBigInt) {
                        const ipNumericStr = ipBigInt.toString();
                        ipNumericMap.set(ipNumericStr, ip);
                        validIPs.push(ipNumericStr);
                    }
                }
            }

            if (validIPs.length === 0) {
                return {};
            }

            // Single query for all IPs (more efficient than individual queries)
            const placeholders = validIPs.map(() => '?').join(', ');
            const query = `
                SELECT DISTINCT ir.company, ir.asn, ir.domain, ir.ip_type,
                       ? as search_ip
                FROM ip_ranges ir
                WHERE ? BETWEEN ir.start_ip_numeric AND ir.end_ip_numeric
                LIMIT 1
            `;

            // We'll need to do individual queries for now, but this is more efficient
            const results = {};
            const batchSize = 50;

            for (let i = 0; i < validIPs.length; i += batchSize) {
                const batch = validIPs.slice(i, i + batchSize);
                const batchPromises = batch.map(async (ipNumeric) => {
                    const ip = ipNumericMap.get(ipNumeric);
                    const info = await this.getIPInfo(ip);
                    return { ip, info };
                });

                const batchResults = await Promise.all(batchPromises);
                batchResults.forEach(({ ip, info }) => {
                    results[ip] = {
                        company: info.company,
                        asn: info.asn,
                        found: info.found
                    };
                });
            }

            return results;

        } catch (error) {
            console.error('❌ Error in bulk IP info lookup:', error.message);
            return {};
        }
    }
    async getCompaniesForIPs(ipList) {
        return this.getCompaniesForIPsWithBinarySearch(ipList);
    }
    async getCompaniesFromCacheOnly(ipList) {
        try {
            if (!this.isInitialized || !ipList || ipList.length === 0) {
                return this.getDefaultCacheResponse(ipList);
            }

            const placeholders = ipList.map(() => '?').join(',');
            const query = `SELECT ip, company, country, asn FROM ip_company_cache WHERE ip IN (${placeholders})`;

            const [rows] = await this.db.execute(query, ipList);

            const results = {};
            rows.forEach(row => {
                results[row.ip] = {
                    company: row.company,
                    country: row.country,
                    asn: row.asn,
                    found: row.company !== 'Unknown',
                    source: 'cache'
                };
            });

            // Fill in missing IPs with "Unknown"
            ipList.forEach(ip => {
                if (!results[ip]) {
                    results[ip] = {
                        company: 'Unknown',
                        country: 'Unknown',
                        asn: 'Unknown',
                        found: false,
                        source: 'cache_miss'
                    };
                }
            });

            console.log(`💾 Cache-only lookup: ${Object.keys(results).length} IPs`);
            return results;

        } catch (error) {
            console.error('❌ Error in cache-only lookup:', error.message);
            return this.getDefaultCacheResponse(ipList);
        }
    }
    getDefaultCacheResponse(ipList) {
        const results = {};
        ipList.forEach(ip => {
            results[ip] = {
                company: 'Unknown',
                country: 'Unknown',
                asn: 'Unknown',
                found: false,
                source: 'error'
            };
        });
        return results;
    }

    async loadIPRangesForBinarySearch() {
        try {
            if (!this.isInitialized) {
                throw new Error('IPInfoService not initialized');
            }

            console.time('LoadIPRangesForBinarySearch');
            const [rows] = await this.db.execute(`
                SELECT start_ip_numeric, end_ip_numeric, company, asn, domain
                FROM ip_ranges 
                WHERE ip_type = 'ipv4'
                ORDER BY start_ip_numeric
            `);
            
            // Store as strings for exact MySQL compatibility
            this.ipRanges = rows.map(row => ({
                start_ip_numeric: row.start_ip_numeric, // Keep as string from MySQL
                end_ip_numeric: row.end_ip_numeric,     // Keep as string from MySQL
                company: row.company,
                asn: row.asn,
                domain: row.domain,
                // country: "Unknown"
            }));
            
            this.isRangesLoaded = true;
            console.timeEnd('LoadIPRangesForBinarySearch');
            console.log(`✅ Loaded ${this.ipRanges.length} IP ranges for binary search`);
            
            return this.ipRanges.length;
        } catch (error) {
            console.error('❌ Error loading IP ranges for binary search:', error);
            this.isRangesLoaded = false;
            return 0;
        }
    }

    binarySearchIPRange(ipNumericString) {
        if (!this.isRangesLoaded || this.ipRanges.length === 0) {
            return null;
        }

        let left = 0;
        let right = this.ipRanges.length - 1;
        
        while (left <= right) {
            const mid = Math.floor((left + right) / 2);
            const range = this.ipRanges[mid];
            
            // Convert to BigInt for comparison (but keep original strings)
            const ipNum = BigInt(ipNumericString);
            const startNum = BigInt(range.start_ip_numeric);
            const endNum = BigInt(range.end_ip_numeric);
            
            // Check if IP is within this range
            if (ipNum >= startNum && ipNum <= endNum) {
                return range; // Found!
            } 
            // If IP is before this range, search left half
            else if (ipNum < startNum) {
                right = mid - 1;
            } 
            // If IP is after this range, search right half
            else {
                left = mid + 1;
            }
        }
        
        return null; // No range found
    }
    async getCompanyWithBinarySearch(ip) {
        try {
            if (!this.isRangesLoaded) {
                await this.loadIPRangesForBinarySearch();
            }

            if (!IPUtils.isIPv4(ip)) {
                return this.getDefaultInfo(ip);
            }

            const ipNumericString = IPUtils.ip2numericString(ip);
            if (!ipNumericString) {
                return this.getDefaultInfo(ip);
            }

            const range = this.binarySearchIPRange(ipNumericString);
            if (range) {
                return {
                    ip: ip,
                    asn: range.asn,
                    company: range.company,
                    domain: range.domain,
                    country: range.country,
                    found: true,
                    source: 'binary_search'
                };
            }

            return this.getDefaultInfo(ip);
        } catch (error) {
            console.error('❌ Error in binary search:', error.message);
            return this.getDefaultInfo(ip);
        }
    }
    async getCompaniesForIPsWithBinarySearch(ipList) {
        try {
            if (!this.isRangesLoaded) {
                await this.loadIPRangesForBinarySearch();
            }

            const results = {};
            const batchSize = 1000;
            
            console.log(`🔍 Processing ${ipList.length} IPs with binary search...`);
            console.time('BinarySearchBatch');

            for (let i = 0; i < ipList.length; i += batchSize) {
                const batch = ipList.slice(i, i + batchSize);
                
                for (const ip of batch) {
                    if (!IPUtils.isIPv4(ip)) {
                        results[ip] = { company: 'Unknown', found: false };
                        continue;
                    }

                    const ipNumericString = IPUtils.ip2numericString(ip);
                    if (!ipNumericString) {
                        results[ip] = { company: 'Unknown', found: false };
                        continue;
                    }

                    const range = this.binarySearchIPRange(ipNumericString);
                    if (range) {
                        results[ip] = {
                            company: range.company,
                            asn: range.asn,
                            found: true,
                            source: 'binary_search'
                        };
                    } else {
                        results[ip] = { company: 'Unknown', found: false };
                    }
                }

                // Progress logging
                if (i % 5000 === 0 || i + batchSize >= ipList.length) {
                    console.log(`📊 Binary search progress: ${Math.min(i + batchSize, ipList.length)}/${ipList.length}`);
                }
            }

            console.timeEnd('BinarySearchBatch');
            console.log(`✅ Binary search completed: ${Object.keys(results).length} IPs processed`);
            
            return results;
        } catch (error) {
            console.error('❌ Error in batch binary search:', error.message);
            return {};
        }
    }

    getBinarySearchStats() {
        return {
            rangesLoaded: this.isRangesLoaded,
            totalRanges: this.ipRanges.length,
            memoryUsage: process.memoryUsage().heapUsed / 1024 / 1024
        };
    }
}

module.exports = new IPInfoService();