const mysql = require('mysql2/promise');
const Measurement = require('../models/Measurement');

class DatabaseService {
  constructor(db) {
    this.db = db;
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
      
      const [rows] = await this.db.execute(query, [proxyPort, proxyPort, limit]);
      return rows.map(row => new Measurement(row));
    } catch (error) {
      console.error('❌ Error getting latest measurements:', error.message);
      throw error;
    }
  }

  // FIXED: Get timeline data with safe parameter binding
  async getMeasurementsTimeline(proxyPort, limitPerTarget = 30) {
    try {
      // First, get distinct targets for this proxy port
      const targetsQuery = `
        SELECT DISTINCT target_host, target_port 
        FROM measurements 
        WHERE proxy_port = ?
        ORDER BY target_host, target_port
        LIMIT 100  -- Limit number of targets to prevent overload
      `;
      
      const [targets] = await this.db.execute(targetsQuery, [proxyPort]);
      
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

  // FIXED: Optimized timeline with proper parameter binding
  async getMeasurementsTimelineOptimized(proxyPort, limitPerTarget = 30) {
    try {
      // For MySQL 8.0+ with window functions - use proper parameter binding
      const query = `
        WITH RankedMeasurements AS (
          SELECT *,
                 ROW_NUMBER() OVER (
                   PARTITION BY target_host, target_port 
                   ORDER BY created_at DESC
                 ) as rn
          FROM measurements 
          WHERE proxy_port = ?
        )
        SELECT * FROM RankedMeasurements 
        WHERE rn <= ?
        ORDER BY target_host, target_port, created_at DESC
      `;
      
      const [rows] = await this.db.execute(query, [proxyPort, limitPerTarget]);
      
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
      return this.getMeasurementsTimeline(proxyPort, limitPerTarget);
    }
  }

  // FIXED: Get paginated timeline data with proper parameters
  async getMeasurementsTimelinePaginated(proxyPort, page = 1, pageSize = 20, limitPerTarget = 30) {
    try {
      // Get targets with pagination
      const targetsQuery = `
        SELECT DISTINCT target_host, target_port 
        FROM measurements 
        WHERE proxy_port = ?
        ORDER BY target_host, target_port
        LIMIT ? OFFSET ?
      `;
      
      const offset = (page - 1) * pageSize;
      const [targets] = await this.db.execute(targetsQuery, [proxyPort, pageSize, offset]);
      
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

  // ALTERNATIVE: Safe method using template literals (if parameter binding continues to fail)
  async getMeasurementsTimelineSafe(proxyPort, limitPerTarget = 30) {
    try {
      // Escape values manually for safety
      const escapedProxyPort = this.db.escape(proxyPort);
      const escapedLimit = this.db.escape(limitPerTarget);
      
      // First, get distinct targets
      const targetsQuery = `
        SELECT DISTINCT target_host, target_port 
        FROM measurements 
        WHERE proxy_port = ${escapedProxyPort}
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

async getDistinctTargets(proxyPort) {
  try {
    const query = `
      SELECT DISTINCT target_host, target_port 
      FROM measurements 
      WHERE proxy_port = ?
      ORDER BY target_host, target_port
    `;
    
    const [rows] = await this.db.execute(query, [proxyPort]);
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
}


module.exports = DatabaseService;