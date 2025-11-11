const mysql = require('mysql2/promise');
const Measurement = require('../models/Measurement');
const IPUtils = require('../utils/ipUtils');
class DatabaseService {
  constructor(db) {
    this.db = db;
  }

  async listPorts() {
    const [rows] = await this.db.execute(
      `SELECT id, port_number AS portNumber, country, country_short AS countryShort,
              provider, provider_short AS providerShort
       FROM ports
       ORDER BY port_number`
    );
    return rows;
  }

  async getPortByNumber(portNumber) {
    const [rows] = await this.db.execute(
      `SELECT id, port_number AS portNumber, country, country_short AS countryShort,
              provider, provider_short AS providerShort
       FROM ports
       WHERE port_number = ?
       LIMIT 1`,
      [portNumber]
    );
    return rows[0] || null;
  }

  async upsertPort({ portNumber, country, countryShort, provider, providerShort }) {
    await this.db.execute(
      `INSERT INTO ports (port_number, country, country_short, provider, provider_short)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         country = VALUES(country),
         country_short = VALUES(country_short),
         provider = VALUES(provider),
         provider_short = VALUES(provider_short),
         updated_at = CURRENT_TIMESTAMP`,
      [portNumber, country, countryShort, provider, providerShort]
    );
  }

  async deletePort(portNumber) {
    const [result] = await this.db.execute(
      `DELETE FROM ports WHERE port_number = ?`,
      [portNumber]
    );
    return result.affectedRows > 0;
  }

  async saveMeasurement(measurement) {
    try {
      const query = `
        INSERT INTO measurements 
        (target_host, target_port, proxy_host, proxy_port, status, rtt_ms, error_message, message, measurement_type) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `;

      const [result] = await this.db.execute(query, [
        measurement.target_host,
        measurement.target_port,
        measurement.proxy_host,
        measurement.proxy_port,
        measurement.status,
        measurement.rtt_ms,
        measurement.error_message,
        measurement.message,
        measurement.measurement_type || 'http'
      ]);

      return result.insertId;
    } catch (error) {
      console.error('❌ Failed to save measurement to DB:', error.message);
      return null;
    }
  }

  // FIXED: Get latest measurements with proper parameter binding
  async getLatestMeasurements(proxyPort, limit = 100) {
    try {
      // Use proper parameter binding for all values
      const query = `
        SELECT m1.* FROM measurements m1
        INNER JOIN (
          SELECT target_host, target_port, MAX(created_at) as max_created
          FROM measurements 
          WHERE proxy_port = ?
          GROUP BY target_host, target_port
        ) m2 ON m1.target_host = m2.target_host 
              AND m1.target_port = m2.target_port 
              AND m1.created_at = m2.max_created
        WHERE m1.proxy_port = ?
        ORDER BY m1.target_host, m1.target_port
        LIMIT ?
      `;

      const [rows] = await this.db.execute(query, [proxyPort, proxyPort, limit.toString()]);
      return rows.map(row => new Measurement(row));
    } catch (error) {
      console.error('❌ Error getting latest measurements:', error.message);
      throw error;
    }
  }

  // FIXED: Get timeline data with filtering by proxyService IP list
  async getMeasurementsTimeline(proxyPort, limitPerTarget = 30, proxyService = null) {
    try {
      if (!proxyService || !proxyService.getTargets) {
        throw new Error('ProxyService instance required for IP filtering');
      }

      const liveIPs = proxyService.getTargetsForPort(proxyPort);
      if (liveIPs.length === 0) {
        console.log(`⚠️ No live IPs available from ProxyService for proxy port ${proxyPort}`);
        return [];
      }

      // Create placeholders for the IN clause
      const placeholders = liveIPs.map(() => '?').join(',');

      const query = `
      SELECT DISTINCT target_host, target_port 
      FROM measurements 
      WHERE proxy_port = ?
        AND target_host IN (${placeholders})
      ORDER BY target_host, target_port
      LIMIT 100
    `;

      const [targets] = await this.db.execute(query, [proxyPort, ...liveIPs]);

      if (targets.length === 0) {
        return [];
      }

      const results = [];

      // Process in batches to avoid too many simultaneous queries
      const batchSize = 10;
      for (let i = 0; i < targets.length; i += batchSize) {
        const batch = targets.slice(i, i + batchSize);

        const batchPromises = batch.map(async (target) => {
          const targetQuery = `
          SELECT * FROM measurements 
          WHERE target_host = ? 
            AND target_port = ?
            AND proxy_port = ?
          ORDER BY created_at DESC 
          LIMIT ?
        `;

          const [measurements] = await this.db.execute(targetQuery, [
            target.target_host,
            target.target_port,
            proxyPort,
            limitPerTarget
          ]);

          return {
            target: `${target.target_host}:${target.target_port}`,
            measurements: measurements.map(row => new Measurement(row)).reverse()
          };
        });

        const batchResults = await Promise.all(batchPromises);
        results.push(...batchResults);
      }

      return results;
    } catch (error) {
      console.error('❌ Error getting timeline:', error.message);
      throw error;
    }
  }

  // FIXED: Optimized timeline with IP list filtering
  async getMeasurementsTimelineOptimized(proxyPort, limitPerTarget = 30, proxyService = null) {
    try {
      if (!proxyService || !proxyService.getTargets) {
        throw new Error('ProxyService instance required for IP filtering');
      }

      let liveIPs = proxyService.getTargetsForPort(proxyPort);
      if (!liveIPs || liveIPs.length === 0) {
        console.log(`⚠️ No live IPs cached for proxy port ${proxyPort}, attempting refresh`);
        try {
          await proxyService.refreshTargets();
        } catch (refreshError) {
          console.error('❌ Failed to refresh targets during optimized timeline fetch:', refreshError.message);
        }
        liveIPs = proxyService.getTargetsForPort(proxyPort);
      }
      if (!liveIPs || liveIPs.length === 0) {
        console.log(`⚠️ No live IPs available from ProxyService for proxy port ${proxyPort}`);
        return [];
      }

      // Create placeholders for the IN clause
      const placeholders = liveIPs.map(() => '?').join(',');

      // For MySQL 8.0+ with window functions
      const query = `
      WITH RankedMeasurements AS (
        SELECT *,
               ROW_NUMBER() OVER (
                 PARTITION BY target_host, target_port 
                 ORDER BY created_at DESC
               ) as rn
        FROM measurements 
        WHERE proxy_port = ?
          AND target_host IN (${placeholders})
      )
      SELECT * FROM RankedMeasurements 
      WHERE rn <= ?
      ORDER BY target_host, target_port, created_at DESC
    `;

      const [rows] = await this.db.execute(query, [proxyPort, ...liveIPs, limitPerTarget]);

      // Group by target
      const targetMap = new Map();
      rows.forEach(row => {
        const targetKey = `${row.target_host}:${row.target_port}`;
        if (!targetMap.has(targetKey)) {
          targetMap.set(targetKey, []);
        }
        targetMap.get(targetKey).push(new Measurement(row));
      });

      // Convert to expected format
      return Array.from(targetMap.entries()).map(([target, measurements]) => ({
        target,
        measurements: measurements.reverse() // Reverse to show oldest first
      }));
    } catch (error) {
      console.error('❌ Error getting optimized timeline:', error.message);
      // Fallback to original method
      return this.getMeasurementsTimeline(proxyPort, limitPerTarget, proxyService);
    }
  }

  // FIXED: Get paginated timeline data with IP filtering
  async getMeasurementsTimelinePaginated(proxyPort, page = 1, pageSize = 20, limitPerTarget = 30, proxyService = null) {
    try {
      if (!proxyService || !proxyService.getTargets) {
        throw new Error('ProxyService instance required for IP filtering');
      }

      const liveIPs = proxyService.getTargetsForPort(proxyPort);
      if (liveIPs.length === 0) {
        console.log(`⚠️ No live IPs available from ProxyService for proxy port ${proxyPort}`);
        return [];
      }

      // Create placeholders for the IN clause
      const placeholders = liveIPs.map(() => '?').join(',');

      // Get targets with pagination and IP filtering
      const targetsQuery = `
      SELECT DISTINCT target_host, target_port 
      FROM measurements 
      WHERE proxy_port = ?
        AND target_host IN (${placeholders})
      ORDER BY target_host, target_port
      LIMIT ? OFFSET ?
    `;

      const offset = (page - 1) * pageSize;
      const [targets] = await this.db.execute(targetsQuery, [proxyPort, ...liveIPs, pageSize.toString(), offset.toString()]);

      if (targets.length === 0) {
        return [];
      }

      const results = await Promise.all(
        targets.map(async (target) => {
          const targetQuery = `
          SELECT * FROM measurements 
          WHERE target_host = ? 
            AND target_port = ?
            AND proxy_port = ?
          ORDER BY created_at DESC 
          LIMIT ?
        `;

          const [measurements] = await this.db.execute(targetQuery, [
            target.target_host,
            target.target_port,
            proxyPort,
            limitPerTarget
          ]);

          return {
            target: `${target.target_host}:${target.target_port}`,
            measurements: measurements.map(row => new Measurement(row)).reverse()
          };
        })
      );

      return results;
    } catch (error) {
      console.error('❌ Error getting paginated timeline:', error.message);
      throw error;
    }
  }

  // FIXED: Safe method with IP filtering
  async getMeasurementsTimelineSafe(proxyPort, limitPerTarget = 30, proxyService = null) {
    try {
      if (!proxyService || !proxyService.getTargets) {
        throw new Error('ProxyService instance required for IP filtering');
      }

      const liveIPs = proxyService.getTargetsForPort(proxyPort);
      if (liveIPs.length === 0) {
        console.log(`⚠️ No live IPs available from ProxyService for proxy port ${proxyPort}`);
        return [];
      }

      // Escape values manually for safety
      const escapedProxyPort = this.db.escape(proxyPort);
      const escapedLimit = this.db.escape(limitPerTarget);
      const escapedIPs = liveIPs.map(ip => this.db.escape(ip)).join(',');

      // First, get distinct targets from live IPs only
      const targetsQuery = `
      SELECT DISTINCT target_host, target_port 
      FROM measurements 
      WHERE proxy_port = ${escapedProxyPort}
        AND target_host IN (${escapedIPs})
      ORDER BY target_host, target_port
      LIMIT 100
    `;

      const [targets] = await this.db.query(targetsQuery);

      if (targets.length === 0) {
        return [];
      }

      const results = [];

      for (const target of targets) {
        const escapedTargetHost = this.db.escape(target.target_host);
        const escapedTargetPort = this.db.escape(target.target_port);

        const targetQuery = `
        SELECT * FROM measurements 
        WHERE target_host = ${escapedTargetHost}
          AND target_port = ${escapedTargetPort}
          AND proxy_port = ${escapedProxyPort}
        ORDER BY created_at DESC 
        LIMIT ${escapedLimit}
      `;

        const [measurements] = await this.db.query(targetQuery);

        results.push({
          target: `${target.target_host}:${target.target_port}`,
          measurements: measurements.map(row => new Measurement(row)).reverse()
        });
      }

      return results;
    } catch (error) {
      console.error('❌ Error getting safe timeline:', error.message);
      throw error;
    }
  }

  // Health check method
  async getTimelineHealth(proxyPort) {
    try {
      const query = `
        SELECT 
          COUNT(DISTINCT target_host, target_port) as targetCount,
          MAX(created_at) as latestMeasurement
        FROM measurements 
        WHERE proxy_port = ?
      `;

      const [result] = await this.db.execute(query, [proxyPort]);
      return result[0];
    } catch (error) {
      console.error('❌ Error in timeline health check:', error.message);
      throw error;
    }
  }

  async getDatabaseStats() {
    try {
      const [measurementCount] = await this.db.execute('SELECT COUNT(*) as count FROM measurements');
      const [targetCount] = await this.db.execute('SELECT COUNT(DISTINCT target_host, target_port) as count FROM measurements');
      const [proxyStats] = await this.db.execute('SELECT proxy_port, COUNT(*) as count FROM measurements GROUP BY proxy_port');

      return {
        measurements: measurementCount[0].count,
        targets: targetCount[0].count,
        proxyStats: proxyStats
      };
    } catch (error) {
      console.error('❌ Error getting database stats:', error.message);
      throw error;
    }
  }
  // Add to DatabaseService class:

  // FIXED: Update other methods to also filter by IP list when needed
  async getDistinctTargets(proxyPort, proxyService = null) {
    try {
      let query = `
      SELECT DISTINCT target_host, target_port 
      FROM measurements 
      WHERE proxy_port = ?
    `;
      let params = [proxyPort];

      // Add IP filtering if proxyService is provided
      if (proxyService && proxyService.getTargetsForPort) {
        const liveIPs = proxyService.getTargetsForPort(proxyPort);
        if (liveIPs.length > 0) {
          const placeholders = liveIPs.map(() => '?').join(',');
          query += ` AND target_host IN (${placeholders})`;
          params.push(...liveIPs);
        }
      }

      query += ` ORDER BY target_host, target_port`;

      const [rows] = await this.db.execute(query, params);
      return rows;
    } catch (error) {
      console.error('❌ Error getting distinct targets:', error.message);
      throw error;
    }
  }

  async getTargetStats(targetHost, targetPort, proxyPort, startTime, endTime) {
    try {
      const query = `
      SELECT 
        AVG(CASE WHEN status = 'success' THEN rtt_ms ELSE NULL END) as avgRtt,
        COUNT(*) as totalMeasurements,
        SUM(CASE WHEN status != 'success' THEN 1 ELSE 0 END) as errorCount
      FROM measurements 
      WHERE target_host = ? 
        AND target_port = ?
        AND proxy_port = ?
        AND created_at BETWEEN ? AND ?
    `;

      const [rows] = await this.db.execute(query, [
        targetHost, targetPort, proxyPort, startTime, endTime
      ]);

      const result = rows[0];
      const errorRate = result.totalMeasurements > 0 ?
        result.errorCount / result.totalMeasurements : 0;

      return {
        avgRtt: result.avgRtt ? parseFloat(result.avgRtt) : null,
        totalMeasurements: result.totalMeasurements,
        errorCount: result.errorCount,
        errorRate: errorRate
      };
    } catch (error) {
      console.error('❌ Error getting target stats:', error.message);
      throw error;
    }
  }

  async getNearestMeasurement(targetHost, targetPort, proxyPort, targetTime, searchWindowMs) {
    try {
      const windowStart = new Date(targetTime.getTime() - searchWindowMs);
      const windowEnd = new Date(targetTime.getTime() + searchWindowMs);

      const query = `
      SELECT *, 
        ABS(TIMESTAMPDIFF(SECOND, ?, created_at)) as time_diff
      FROM measurements 
      WHERE target_host = ? 
        AND target_port = ?
        AND proxy_port = ?
        AND created_at BETWEEN ? AND ?
      ORDER BY time_diff ASC
      LIMIT 1
    `;

      const [rows] = await this.db.execute(query, [
        targetTime, targetHost, targetPort, proxyPort, windowStart, windowEnd
      ]);

      return rows.length > 0 ? rows[0] : null;
    } catch (error) {
      console.error('❌ Error getting nearest measurement:', error.message);
      return null;
    }
  }

  async getRangeMeasurements(proxyPort, startTime, endTime, segmentCount, segmentSizeMs) {
    try {
      const totalTimeMs = endTime - startTime;
      const segmentSizeSeconds = Math.floor(segmentSizeMs / 1000);
      // Convert startTime to UNIX timestamp for calculation
      const startTimeUnix = Math.floor(startTime.getTime() / 1000);
      const query = `
            SELECT 
                target_host,
                target_port,
                FLOOR((UNIX_TIMESTAMP(created_at) - ?) / ?) as segment_index,
                AVG(CASE WHEN status = 'success' THEN rtt_ms ELSE NULL END) as avg_rtt,
                COUNT(*) as total_measurements,
                SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success_count
            FROM measurements 
            WHERE proxy_port = ?
                AND created_at BETWEEN ? AND ?
            GROUP BY target_host, target_port, segment_index
            ORDER BY target_host, target_port, segment_index
        `;

      const [rows] = await this.db.execute(query, [
        startTimeUnix,        // Subtract start time to make it relative
        segmentSizeSeconds,   // Segment size in seconds
        proxyPort,
        startTime,
        endTime
      ]);

      console.log(`📈 Range query returned ${rows.length} segment records`);
      return rows;

    } catch (error) {
      console.error('❌ Error in getRangeMeasurements:', error.message);
      throw error;
    }
  }

  // Add these methods to your DatabaseService class:

  async getDistinctTargetsCount(proxyPort, startTime, endTime, companyFilter = '') {
    try {
      const formatToLocalMySQL = (date) => {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        const hours = String(date.getHours()).padStart(2, '0');
        const minutes = String(date.getMinutes()).padStart(2, '0');
        const seconds = String(date.getSeconds()).padStart(2, '0');
        return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
      };

      const startTimeStr = formatToLocalMySQL(startTime);
      const endTimeStr = formatToLocalMySQL(endTime);

      let query = `
            SELECT COUNT(DISTINCT CONCAT(m.target_host, ':', m.target_port)) as total
            FROM measurements m
            WHERE m.proxy_port = ?
            AND m.created_at BETWEEN ? AND ?
        `;

      const params = [proxyPort, startTimeStr, endTimeStr];

      // Add company filter if provided
      if (companyFilter && companyFilter !== '') {
        query += ` AND m.target_host IN (
                SELECT DISTINCT ir.start_ip 
                FROM ip_ranges ir 
                WHERE ir.company = ?
            )`;
        params.push(companyFilter);
      }

      const [rows] = await this.db.execute(query, params);
      return rows[0].total;
    } catch (error) {
      console.error('❌ Error getting distinct targets count:', error.message);
      throw error;
    }
  }


  async getRangeMeasurementsPaginated(proxyPort, startTime, endTime, segmentCount, segmentSizeMs, offset, limit, liveIPs = [], companyFilter = '') {
    try {
      const segmentSizeSeconds = Math.floor(segmentSizeMs / 1000);
      const startTimeUnix = Math.floor(startTime.getTime() / 1000);

      const formatToLocalMySQL = (date) => {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        const hours = String(date.getHours()).padStart(2, '0');
        const minutes = String(date.getMinutes()).padStart(2, '0');
        const seconds = String(date.getSeconds()).padStart(2, '0');
        return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
      };

      const startTimeStr = formatToLocalMySQL(startTime);
      const endTimeStr = formatToLocalMySQL(endTime);

      console.log('🕒 Query time range:', { startTime: startTimeStr, endTime: endTimeStr, companyFilter });

      // STEP 1: Get paginated targets first (fast query)
      let targetsQuery = '';
      let targetsParams = [];

      if (liveIPs.length > 0) {
        const livePlaceholders = liveIPs.map(() => '?').join(', ');
        targetsQuery = `
                SELECT DISTINCT m.target_host, m.target_port,
                       CASE WHEN m.target_host IN (${livePlaceholders}) THEN 1 ELSE 0 END as is_live
                FROM measurements m
                WHERE m.proxy_port = ?
                AND m.created_at BETWEEN ? AND ?
            `;
        targetsParams = [...liveIPs, proxyPort.toString(), startTimeStr, endTimeStr];
      } else {
        targetsQuery = `
                SELECT DISTINCT m.target_host, m.target_port, 0 as is_live
                FROM measurements m
                WHERE m.proxy_port = ?
                AND m.created_at BETWEEN ? AND ?
            `;
        targetsParams = [proxyPort.toString(), startTimeStr, endTimeStr];
      }

      // Add company filter to targets query
      if (companyFilter && companyFilter !== '') {
        targetsQuery += ` AND m.target_host IN (
                SELECT DISTINCT ir.start_ip 
                FROM ip_ranges ir 
                WHERE ir.company = ?
            )`;
        targetsParams.push(companyFilter);
      }

      targetsQuery += ` ORDER BY is_live DESC, m.target_host, m.target_port LIMIT ? OFFSET ?`;
      targetsParams.push(limit.toString(), offset.toString());

      console.time('TargetsQuery');
      const [targets] = await this.db.execute(targetsQuery, targetsParams);
      console.timeEnd('TargetsQuery');

      if (targets.length === 0) {
        return [];
      }

      console.log(`📍 Found ${targets.length} targets (${targets.filter(t => t.is_live).length} live) with company: ${companyFilter || 'All'}`);

      // STEP 2: SINGLE QUERY for all targets using IN clause
      const targetConditions = targets.map(() => '(target_host = ? AND target_port = ?)').join(' OR ');
      const targetParams = targets.flatMap(t => [t.target_host, t.target_port]);

      const singleQuery = `
            SELECT 
                target_host,
                target_port,
                FLOOR((UNIX_TIMESTAMP(created_at) - ?) / ?) as segment_index,
                AVG(CASE WHEN status = 'success' THEN rtt_ms ELSE NULL END) as avg_rtt,
                COUNT(*) as total_measurements,
                SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success_count
            FROM measurements 
            WHERE proxy_port = ?
                AND created_at BETWEEN ? AND ?
                AND (${targetConditions})
            GROUP BY target_host, target_port, FLOOR((UNIX_TIMESTAMP(created_at) - ?) / ?)
            ORDER BY target_host, target_port, segment_index
        `;

      const singleQueryParams = [
        startTimeUnix,
        segmentSizeSeconds,
        proxyPort.toString(),
        startTimeStr,
        endTimeStr,
        ...targetParams,
        startTimeUnix,
        segmentSizeSeconds
      ];

      console.time('SingleRangeQuery');
      const [allResults] = await this.db.execute(singleQuery, singleQueryParams);
      console.timeEnd('SingleRangeQuery');

      console.log(`📊 Single query returned ${allResults.length} segments for ${targets.length} targets`);
      return allResults;

    } catch (error) {
      console.error('❌ Error in getRangeMeasurementsPaginated:', error.message);
      throw error;
    }
  }
  async getDistinctCompanies() {
    try {
      const query = `
            SELECT DISTINCT company 
            FROM ip_ranges 
            WHERE company != '' AND company IS NOT NULL
            ORDER BY company
        `;
      const [rows] = await this.db.execute(query);
      return rows.map(row => row.company);
    } catch (error) {
      console.error('❌ Error getting distinct companies:', error.message);
      return [];
    }
  }
  async getDistinctTargetsInPeriod(proxyPort, startTime, endTime, companyFilter = '') {
    try {
      const formatToLocalMySQL = (date) => {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        const hours = String(date.getHours()).padStart(2, '0');
        const minutes = String(date.getMinutes()).padStart(2, '0');
        const seconds = String(date.getSeconds()).padStart(2, '0');
        return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
      };

      const startTimeStr = formatToLocalMySQL(startTime);
      const endTimeStr = formatToLocalMySQL(endTime);

      let query = `
            SELECT DISTINCT m.target_host
            FROM measurements m
            WHERE m.proxy_port = ?
            AND m.created_at BETWEEN ? AND ?
        `;

      const params = [proxyPort, startTimeStr, endTimeStr];

      // Add company filter if provided
      if (companyFilter && companyFilter !== '') {
        query += ` AND m.target_host IN (
                SELECT DISTINCT ir.start_ip 
                FROM ip_ranges ir 
                WHERE ir.company = ?
            )`;
        params.push(companyFilter);
      }

      query += ` ORDER BY m.target_host`;

      const [rows] = await this.db.execute(query, params);
      const ipList = rows.map(row => row.target_host);
      console.log(`📊 Found ${ipList.length} historical IPs in period with company filter: ${companyFilter || 'All'}`);

      return ipList;

    } catch (error) {
      console.error('❌ Error getting distinct targets in period:', error.message);
      return [];
    }
  }
  async getHistoricalIPsWithTime(proxyPort, startTime, endTime) {
    try {
      const formatToLocalMySQL = (date) => {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        const hours = String(date.getHours()).padStart(2, '0');
        const minutes = String(date.getMinutes()).padStart(2, '0');
        const seconds = String(date.getSeconds()).padStart(2, '0');
        return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
      };

      const startTimeStr = formatToLocalMySQL(startTime);
      const endTimeStr = formatToLocalMySQL(endTime);

      const query = `
            SELECT 
                target_host,
                MAX(created_at) as last_inserted_time,
                COUNT(*) as measurement_count
            FROM measurements 
            WHERE proxy_port = ?
            AND created_at BETWEEN ? AND ?
            GROUP BY target_host
            ORDER BY last_inserted_time DESC
        `;

      const [rows] = await this.db.execute(query, [proxyPort, startTimeStr, endTimeStr]);
      return rows;
    } catch (error) {
      console.error('❌ Error getting historical IPs with time:', error.message);
      throw error;
    }
  }
  async getCompanyInfoWithCache(ipList) {
    try {
      if (!ipList || ipList.length === 0) return {};

      const results = {};
      const ipsToLookup = [];

      // STEP 1: Check MEMORY cache first (very fast)
      const placeholders = ipList.map(() => '?').join(',');
      const cacheQuery = `SELECT ip, company, country, asn FROM ip_company_cache WHERE ip IN (${placeholders})`;

      console.time('MemoryCacheLookup');
      const [cachedRows] = await this.db.execute(cacheQuery, ipList);
      console.timeEnd('MemoryCacheLookup');

      // Add cached results
      cachedRows.forEach(row => {
        results[row.ip] = {
          company: row.company,
          country: row.country,
          asn: row.asn,
          found: true,
          source: 'memory_cache'
        };
      });

      // STEP 2: Find IPs not in cache
      const cachedIPs = new Set(cachedRows.map(row => row.ip));
      ipsToLookup.push(...ipList.filter(ip => !cachedIPs.has(ip)));

      console.log(`💾 Memory Cache: ${cachedRows.length} hits, ${ipsToLookup.length} misses`);

      // STEP 3: Lookup missing IPs in ip_ranges (disk-based)
      if (ipsToLookup.length > 0) {
        const IPInfoService = require('../services/ipInfoService');
        console.time('IPRangesLookup');
        const lookupResults = await IPInfoService.getCompaniesForIPs(ipsToLookup);
        console.timeEnd('IPRangesLookup');

        // STEP 4: Save to MEMORY cache and add to results
        const savePromises = [];

        for (const [ip, info] of Object.entries(lookupResults)) {
          results[ip] = {
            company: info.company,
            country: info.country || 'Unknown',
            asn: info.asn || 'Unknown',
            found: info.found,
            source: 'ip_ranges'
          };

          // Save to MEMORY cache (async - don't wait)
          if (info.found && info.company !== 'Unknown') {
            savePromises.push(
              this.saveToCompanyCache(ip, info.company, info.country, info.asn)
            );
          }
        }

        // Wait for all cache saves to complete
        await Promise.all(savePromises);
        console.log(`💾 Saved ${savePromises.length} new entries to memory cache`);
      }

      return results;
    } catch (error) {
      console.error('❌ Error in company info with memory cache:', error.message);
      return {};
    }
  }
  async saveToCompanyCache(ip, company, country = 'Unknown', asn = 'Unknown', ipNumeric = null) {
    try {
      let numericValue = ipNumeric;
      if (!numericValue) {
        // Calculate if not provided
        const ipBigInt = IPUtils.ip2bigint(ip);
        numericValue = ipBigInt ? ipBigInt.toString() : null;
      }

      const query = `
            INSERT INTO ip_company_cache (ip, company, country, asn, ip_numeric, source, last_updated)
            VALUES (?, ?, ?, ?, ?, 'ip_ranges', CURRENT_TIMESTAMP)
            ON DUPLICATE KEY UPDATE 
                company = VALUES(company),
                country = VALUES(country),
                asn = VALUES(asn),
                ip_numeric = VALUES(ip_numeric),
                last_updated = CURRENT_TIMESTAMP
        `;

      await this.db.execute(query, [ip, company, country, asn, numericValue]);
      return true;
    } catch (error) {
      console.error('❌ Error saving to company cache:', error.message);
      return false;
    }
  }

  formatChartData(rows, targetIPs, segmentCount) {
    const ipDataMap = new Map();

    // Initialize IP data structure
    targetIPs.forEach(ip => {
      ipDataMap.set(ip, {
        target_host: ip,
        target_port: 80, // Default port
        segments: new Array(segmentCount).fill(null).map(() => ({
          avgRtt: null,
          measurementCount: 0,
          successCount: 0,
          successRate: 0
        })),
        allRtts: [],
        allMeasurements: 0,
        successMeasurements: 0,
        isLive: targetIPs.includes(ip) // Adjust based on your live IP logic
      });
    });

    // Fill with actual data
    rows.forEach(record => {
      const ipKey = record.target_host;
      if (ipDataMap.has(ipKey)) {
        const ipData = ipDataMap.get(ipKey);

        // Ensure segment index is within bounds
        const segmentIndex = Math.min(Math.max(0, record.segment_index), segmentCount - 1);

        ipData.segments[segmentIndex] = {
          avgRtt: record.avg_rtt !== null ? Number(record.avg_rtt) : null,
          measurementCount: Number(record.total_measurements),
          successCount: Number(record.success_count),
          successRate: record.total_measurements > 0 ? Number(record.success_count) / Number(record.total_measurements) : 0
        };

        // Collect for overall stats
        if (record.avg_rtt !== null) {
          ipData.allRtts.push(record.avg_rtt);
        }
        ipData.allMeasurements += record.total_measurements;
        ipData.successMeasurements += record.success_count;
      }
    });

    // Convert to array and calculate overall stats
    return Array.from(ipDataMap.values()).map(ipData => {
      const validRtts = ipData.segments
        .filter(segment => segment.avgRtt !== null && !isNaN(segment.avgRtt))
        .map(segment => segment.avgRtt);

      const totalAvgRtt = validRtts.length > 0 ?
        validRtts.reduce((sum, rtt) => sum + rtt, 0) / validRtts.length : null;

      const overallSuccessRate = ipData.allMeasurements > 0 ?
        ipData.successMeasurements / ipData.allMeasurements : 0;

      return {
        ...ipData,
        totalAvgRtt,
        overallSuccessRate,
        statusSquare: this.getStatusSquare(totalAvgRtt, overallSuccessRate),
        color: ipData.isLive ? '#3b82f6' : '#6b7280'
      };
    });
  }
  getStatusSquare(avgRtt, successRate) {
    if (successRate < 0.5) return 'critical';
    if (!avgRtt || avgRtt === null) return 'no-data';
    if (avgRtt > 1000) return 'critical';
    if (avgRtt > 500) return 'warning';
    if (avgRtt > 200) return 'normal';
    if (avgRtt > 100) return 'good';
    return 'excellent';
  }

  async initializeMemoryCache() {
    try {
      // Clear cache on startup (optional - remove if you want persistence)
      await this.db.execute('DELETE FROM ip_company_cache');
      console.log('🧹 Cleared memory cache on startup');

      // Pre-load cache with frequently used IPs (optional)
      await this.preloadCommonIPs();

    } catch (error) {
      console.error('❌ Error initializing memory cache:', error.message);
    }
  }

  // Pre-load cache with common IPs for faster initial access
  async preloadCommonIPs() {
    try {
      const commonIPs = [
        '8.8.8.8', '1.1.1.1', '9.9.9.9', // DNS servers
        '208.67.222.222', '208.67.220.220' // OpenDNS
      ];

      const IPInfoService = require('../services/ipInfoService');
      const companyInfo = await IPInfoService.getCompaniesForIPs(commonIPs);

      for (const [ip, info] of Object.entries(companyInfo)) {
        if (info.found && info.company !== 'Unknown') {
          await this.saveToCompanyCache(ip, info.company, info.country, info.asn);
        }
      }

      console.log(`✅ Pre-loaded ${Object.keys(companyInfo).length} common IPs to memory cache`);
    } catch (error) {
      console.error('❌ Error pre-loading common IPs:', error.message);
    }
  }

  async getCompanyFromCache(ipList) {
    try {
      if (!ipList || ipList.length === 0) return {};

      const batchSize = 50; // Smaller batches
      const allResults = [];
      console.time('GetCompanyInfo');
      for (let i = 0; i < ipList.length; i += batchSize) {
        const batch = ipList.slice(i, i + batchSize);
        const placeholders = batch.map(() => '?').join(',');
        const query = `SELECT ip, company, country, asn FROM ip_company_cache WHERE ip IN (${placeholders})`;

        const [rows] = await this.db.execute(query, batch);
        allResults.push(...rows);
      }
      console.timeEnd('GetCompanyInfo');
      const results = {};
      allResults.forEach(row => {
        results[row.ip] = {
          company: row.company,
          // country: row.country,
          // asn: row.asn,
          found: row.company !== 'Unknown',
          source: 'cache'
        };
      });

      // Add missing IPs as "Unknown"
      ipList.forEach(ip => {
        if (!results[ip]) {
          results[ip] = {
            company: 'Unknown',
            // country: 'Unknown',
            // asn: 'Unknown',
            found: false,
            source: 'cache_miss'
          };
        }
      });

      return results;
    } catch (error) {
      console.error('❌ Error getting company from cache:', error.message);
      return {};
    }
  }
  async getCompanyFromCacheWithBinarySearch(ipList) {
    try {
      if (!ipList || ipList.length === 0) return {};

      // Convert IPs to numeric for efficient lookup
      const ipNumericMap = new Map();
      const numericIPs = [];

      for (const ip of ipList) {
        const ipBigInt = IPUtils.ip2bigint(ip);
        if (ipBigInt) {
          const numericStr = ipBigInt.toString();
          ipNumericMap.set(numericStr, ip);
          numericIPs.push(numericStr);
        }
      }

      if (numericIPs.length === 0) return {};

      // Single query with numeric values for fast lookup
      const placeholders = numericIPs.map(() => '?').join(',');
      const query = `
            SELECT ip, company, country, asn, ip_numeric 
            FROM ip_company_cache 
            WHERE ip_numeric IN (${placeholders})
        `;

      const [rows] = await this.db.execute(query, numericIPs);

      const results = {};
      rows.forEach(row => {
        const originalIP = ipNumericMap.get(row.ip_numeric);
        if (originalIP) {
          results[originalIP] = {
            company: row.company,
            country: row.country,
            asn: row.asn,
            found: row.company !== 'Unknown',
            source: 'cache'
          };
        }
      });

      // Fill missing IPs
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

      return results;
    } catch (error) {
      console.error('❌ Error in cache lookup with binary search:', error.message);
      return {};
    }
  }

  async getRangeMeasurementsSmart(proxyPort, startTime, endTime, segmentCount, segmentSizeMs, liveIPs = [], companyFilter = '') {
    try {
      const segmentSizeSeconds = Math.floor(segmentSizeMs / 1000);
      const startTimeUnix = Math.floor(startTime.getTime() / 1000);

      const formatToLocalMySQL = (date) => {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        const hours = String(date.getHours()).padStart(2, '0');
        const minutes = String(date.getMinutes()).padStart(2, '0');
        const seconds = String(date.getSeconds()).padStart(2, '0');
        return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
      };

      const startTimeStr = formatToLocalMySQL(startTime);
      const endTimeStr = formatToLocalMySQL(endTime);

      // STEP 1: Get ALL targets with RTT statistics for sorting
      // Handle empty liveIPs array to avoid invalid SQL IN () clause
      const isLiveClause = liveIPs.length > 0
        ? `CASE WHEN m.target_host IN (${liveIPs.map(() => '?').join(',')}) THEN 1 ELSE 0 END`
        : '0';
      
      let targetsQuery = `
        SELECT 
          m.target_host,
          AVG(CASE WHEN m.status = 'success' THEN m.rtt_ms ELSE NULL END) as avg_rtt,
          COUNT(*) as total_measurements,
          SUM(CASE WHEN m.status = 'success' THEN 1 ELSE 0 END) as success_count,
          ${isLiveClause} as is_live
        FROM measurements m
        WHERE m.proxy_port = ?
        AND m.created_at BETWEEN ? AND ?
      `;
      let targetsParams = liveIPs.length > 0
        ? [...liveIPs, proxyPort.toString(), startTimeStr, endTimeStr]
        : [proxyPort.toString(), startTimeStr, endTimeStr];

      // Add company filter if provided
      // Use EXISTS instead of IN for potentially better performance
      if (companyFilter && companyFilter !== '') {
        targetsQuery += ` AND EXISTS (
          SELECT 1 
          FROM ip_company_cache icc 
          WHERE icc.ip = m.target_host AND icc.company = ?
        )`;
        targetsParams.push(companyFilter);
      }

      targetsQuery += ` 
        GROUP BY m.target_host
        ORDER BY 
          is_live DESC,  -- Live IPs first
          avg_rtt DESC    -- Then by RTT (fastest first)
        LIMIT 1000  -- Limit targets to avoid processing too many
      `;

      console.time('SmartTargetsQuery');
      const [targets] = await this.db.execute(targetsQuery, targetsParams);
      console.timeEnd('SmartTargetsQuery');

      if (targets.length === 0) {
        return [];
      }

      console.log(`📍 Found ${targets.length} targets (${targets.filter(t => t.is_live).length} live) with company: ${companyFilter || 'All'}`);

      // STEP 2: SINGLE QUERY for all targets using IN clause
      // Limit to reasonable number of targets for performance
      const maxTargets = 1000;
      const limitedTargets = targets.slice(0, maxTargets);
      const targetPlaceholders = limitedTargets.map(() => '?').join(',');
      const targetHosts = limitedTargets.map(t => t.target_host);

      // Optimize: Calculate segment_index once and reuse in GROUP BY
      // Use derived table to calculate segment_index once, then group
      const singleQuery = `
        SELECT 
          target_host,
          segment_index,
          AVG(CASE WHEN status = 'success' THEN rtt_ms ELSE NULL END) as avg_rtt,
          COUNT(*) as total_measurements,
          SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success_count
        FROM (
          SELECT 
            target_host,
            status,
            rtt_ms,
            FLOOR((UNIX_TIMESTAMP(created_at) - ?) / ?) as segment_index
          FROM measurements 
          WHERE proxy_port = ?
            AND created_at BETWEEN ? AND ?
            AND target_host IN (${targetPlaceholders})
        ) as segmented_data
        GROUP BY target_host, segment_index
        ORDER BY target_host, segment_index
      `;
      const singleQueryParams = [
        startTimeUnix,
        segmentSizeSeconds,
        proxyPort.toString(),
        startTimeStr,
        endTimeStr,
        ...targetHosts,
        // startTimeUnix,
        // segmentSizeSeconds
      ];

      console.time('SingleRangeQuery');
      const [allResults] = await this.db.execute(singleQuery, singleQueryParams);
      console.timeEnd('SingleRangeQuery');

      console.log(`📊 Smart query returned ${allResults.length} segments for ${targets.length} targets`);

      // STEP 3: Format data with proper sorting and live IP info
      // Use limited targets for formatting since we limited the query
      return this.formatSmartChartData(allResults, limitedTargets, segmentCount, liveIPs);

    } catch (error) {
      console.error('❌ Error in getRangeMeasurementsSmart:', error.message);
      throw error;
    }
  }

  // NEW: Format data with proper sorting
  formatSmartChartData(rows, targets, segmentCount, liveIPs) {
    const ipDataMap = new Map();

    // Initialize IP data structure with targets order (already sorted by RTT)
    targets.forEach(target => {
      ipDataMap.set(target.target_host, {
        target_host: target.target_host,
        target_port: 80,
        segments: new Array(segmentCount).fill(null).map(() => ({
          avgRtt: null,
          measurementCount: 0,
          successCount: 0,
          successRate: 0
        })),
        allRtts: [],
        allMeasurements: 0,
        successMeasurements: 0,
        isLive: liveIPs.includes(target.target_host), // Correct live IP detection
        totalAvgRtt: target.avg_rtt ? Number(target.avg_rtt) : null,
        overallSuccessRate: target.total_measurements > 0 ?
          Number(target.success_count) / Number(target.total_measurements) : 0
      });
    });

    // Fill with actual segment data
    rows.forEach(record => {
      const ipKey = record.target_host;
      if (ipDataMap.has(ipKey)) {
        const ipData = ipDataMap.get(ipKey);

        // Ensure segment index is within bounds
        const segmentIndex = Math.min(Math.max(0, record.segment_index), segmentCount - 1);

        ipData.segments[segmentIndex] = {
          avgRtt: record.avg_rtt !== null ? Number(record.avg_rtt) : null,
          measurementCount: Number(record.total_measurements),
          successCount: Number(record.success_count),
          successRate: record.total_measurements > 0 ?
            Number(record.success_count) / Number(record.total_measurements) : 0
        };

        // Collect for overall stats (if not already set from targets)
        if (record.avg_rtt !== null) {
          ipData.allRtts.push(record.avg_rtt);
        }
        ipData.allMeasurements += record.total_measurements;
        ipData.successMeasurements += record.success_count;
      }
    });

    // Convert to array maintaining the sorted order from targets
    const sortedIPs = [];
    targets.forEach(target => {
      const ipData = ipDataMap.get(target.target_host);
      if (ipData) {
        // Calculate final stats if needed
        const validRtts = ipData.segments
          .filter(segment => segment.avgRtt !== null && !isNaN(segment.avgRtt))
          .map(segment => segment.avgRtt);

        // Use target's avg_rtt if available, otherwise calculate from segments
        if (!ipData.totalAvgRtt && validRtts.length > 0) {
          ipData.totalAvgRtt = validRtts.reduce((sum, rtt) => sum + rtt, 0) / validRtts.length;
        }

        if (!ipData.overallSuccessRate && ipData.allMeasurements > 0) {
          ipData.overallSuccessRate = ipData.successMeasurements / ipData.allMeasurements;
        }

        ipData.statusSquare = this.getStatusSquare(ipData.totalAvgRtt, ipData.overallSuccessRate);
        ipData.color = ipData.isLive ? '#3b82f6' : '#6b7280';

        sortedIPs.push(ipData);
      }
    });

    return sortedIPs;
  }

  // Remove old paginated function since we're using the smart one
  // async getRangeMeasurementsPaginated() { ... } - REMOVE THIS

  // Keep other existing methods but update getChartDataForIPs to use new smart function
  async getChartDataForIPs(proxyPort, startTime, endTime, segmentCount, segmentSizeMs, targetIPs, period, liveIPs = []) {
    try {
      // Use the new smart function but filter by specific IPs
      const allData = await this.getRangeMeasurementsSmart(
        proxyPort, startTime, endTime, segmentCount, segmentSizeMs, liveIPs
      );

      // Filter to only include the requested targetIPs
      const filteredData = allData.filter(ipData => targetIPs.includes(ipData.target_host));

      console.log(`📈 Filtered to ${filteredData.length} IPs from smart query`);
      return filteredData;
    } catch (error) {
      console.error('❌ Error in getChartDataForIPs:', error.message);
      throw error;
    }
  }

  /**
   * Helper: Format date to MySQL TIMESTAMP format (YYYY-MM-DD HH:MM:SS)
   * @param {Date} date - Date object
   * @returns {string} MySQL formatted timestamp string
   */
  formatToMySQLTimestamp(date) {
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    const hours = String(date.getUTCHours()).padStart(2, '0');
    const minutes = String(date.getUTCMinutes()).padStart(2, '0');
    const seconds = String(date.getUTCSeconds()).padStart(2, '0');
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
  }

  /**
   * Helper: Calculate cutoff date (N days ago in UTC)
   * @param {number} retentionDays - Number of days to retain
   * @returns {Date} Cutoff date (start of day in UTC)
   */
  calculateCutoffDate(retentionDays) {
    const cutoffDate = new Date();
    cutoffDate.setUTCDate(cutoffDate.getUTCDate() - retentionDays);
    cutoffDate.setUTCHours(0, 0, 0, 0);
    return cutoffDate;
  }

  /**
   * Generic cleanup function for any table with created_at or timestamp column
   * @param {string} tableName - Table name to clean up
   * @param {string} dateColumn - Date column name ('created_at' or 'timestamp')
   * @param {number} retentionDays - Number of days to keep
   * @param {string} timerLabel - Label for console.time/timeEnd
   * @returns {Promise<{deletedCount: number, success: boolean, cutoffDate?: string}>}
   */
  async cleanupOldData(tableName, dateColumn, retentionDays, timerLabel) {
    try {
      console.time(timerLabel);
      console.log(`🧹 Starting cleanup of ${tableName} older than ${retentionDays} days...`);

      const cutoffDate = this.calculateCutoffDate(retentionDays);
      const cutoffDateStr = this.formatToMySQLTimestamp(cutoffDate);
 
      // Get count of records to delete
      const [countResult] = await this.db.execute(
        `SELECT COUNT(*) as count FROM ${tableName} WHERE ${dateColumn} < ?`,
        [cutoffDateStr]
      );
      const countToDelete = countResult[0]?.count || 0;

      if (countToDelete === 0) {
        console.log(`✅ No old ${tableName} to clean up`);
        console.timeEnd(timerLabel);
        return { deletedCount: 0, success: true };
      }

      console.log(`🗑️  Found ${countToDelete} ${tableName} records older than ${cutoffDateStr} (UTC)`);

      // Delete old records
      const [result] = await this.db.execute(
        `DELETE FROM ${tableName} WHERE ${dateColumn} < ?`,
        [cutoffDateStr]
      );

      const deletedCount = result.affectedRows || 0;
      console.log(`✅ Cleanup completed: Deleted ${deletedCount} old ${tableName} records`);
      console.timeEnd(timerLabel);

      return {
        deletedCount,
        success: true,
        cutoffDate: cutoffDateStr
      };
    } catch (error) {
      console.error(`❌ Error cleaning up ${tableName}:`, error.message);
      console.timeEnd(timerLabel);
      return {
        deletedCount: 0,
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Clean up old measurements data - keeps only the last 2 days
   * @param {number} retentionDays - Number of days to keep (default: 2)
   * @returns {Promise<{deletedCount: number, success: boolean}>}
   */
  async cleanupOldMeasurements(retentionDays = 2) {
    return this.cleanupOldData('measurements', 'created_at', retentionDays, 'CleanupOldMeasurements');
  }

  /**
   * Clean up old server_metrics data - keeps only the last 7 days
   * @param {number} retentionDays - Number of days to keep (default: 7)
   * @returns {Promise<{deletedCount: number, success: boolean}>}
   */
  async cleanupOldServerMetrics(retentionDays = 7) {
    return this.cleanupOldData('server_metrics', 'created_at', retentionDays, 'CleanupOldServerMetrics');
  }
}


module.exports = DatabaseService;