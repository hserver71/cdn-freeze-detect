class MetricsController {
  constructor(db) {
    this.db = db;
  }

  /**
   * POST /api/metrics
   * Save server metrics
   */
  async saveMetrics(req, res) {
    try {
      const {
        server,
        timestamp,
        cpu_usage,
        mem_usage,
        disk_read_mb,
        disk_write_mb,
        disk_read_mb_per_min,
        disk_write_mb_per_min,
        nginx_request_count_per_min,
      } = req.body;

      if (!server || !timestamp) {
        return res.status(400).json({
          success: false,
          error: 'Missing required fields: server or timestamp',
        });
      }

      // Validate timestamp (should be a Unix timestamp)
      let normalizedTimestamp = timestamp;
      if (typeof normalizedTimestamp === 'string') {
        normalizedTimestamp = Number(normalizedTimestamp);
      }

      if (typeof normalizedTimestamp !== 'number' || Number.isNaN(normalizedTimestamp) || normalizedTimestamp <= 0) {
        return res.status(400).json({
          success: false,
          error: 'Invalid timestamp format. Expected Unix timestamp (number)',
        });
      }

      // Support millisecond timestamps
      if (normalizedTimestamp > 9999999999) {
        normalizedTimestamp = Math.floor(normalizedTimestamp / 1000);
      }

      // Validate numeric ranges
      if (cpu_usage !== undefined && (cpu_usage < 0 || cpu_usage > 100)) {
        return res.status(400).json({
          success: false,
          error: 'cpu_usage must be between 0 and 100',
        });
      }

      if (mem_usage !== undefined && (mem_usage < 0 || mem_usage > 100)) {
        return res.status(400).json({
          success: false,
          error: 'mem_usage must be between 0 and 100',
        });
      }

      // Save metrics into MySQL
      const insertQuery = `
        INSERT INTO server_metrics (
          server,
          timestamp,
          cpu_usage,
          mem_usage,
          disk_read_mb,
          disk_write_mb,
          disk_read_mb_per_min,
          disk_write_mb_per_min,
          nginx_request_count_per_min
        ) VALUES (?, FROM_UNIXTIME(?), ?, ?, ?, ?, ?, ?, ?)
      `;

      await this.db.execute(insertQuery, [
        server,
        normalizedTimestamp,
        cpu_usage || 0,
        mem_usage || 0,
        disk_read_mb || 0,
        disk_write_mb || 0,
        disk_read_mb_per_min || 0,
        disk_write_mb_per_min || 0,
        nginx_request_count_per_min || 0,
      ]);

      res.json({
        success: true,
        message: 'Metrics saved successfully',
        server,
        timestamp,
      });
    } catch (error) {
      console.error('❌ Error saving metrics:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to save metrics',
        details: process.env.NODE_ENV === 'development' ? error.message : undefined,
      });
    }
  }

  /**
   * GET /api/metrics
   * Get metrics with optional filters
   * Query params: server, startTime, endTime, limit, page, pageSize
   */
  async getMetrics(req, res) {
    try {
      const {
        server,
        startTime,
        endTime,
        limit = '100',
        page,
        pageSize = '50',
      } = req.query;

      let query = 'SELECT * FROM server_metrics WHERE 1=1';
      const params = [];

      // Filter by server
      if (server) {
        query += ' AND server = ?';
        params.push(server);
      }

      // Filter by time range
      if (startTime) {
        query += ' AND timestamp >= FROM_UNIXTIME(?)';
        params.push(parseInt(startTime, 10));
      }

      if (endTime) {
        query += ' AND timestamp <= FROM_UNIXTIME(?)';
        params.push(parseInt(endTime, 10));
      }

      // Order by timestamp descending (most recent first)
      query += ' ORDER BY timestamp DESC';

      // Handle pagination
      if (page) {
        const pageNum = parseInt(page, 10);
        const pageSizeNum = Math.min(parseInt(pageSize, 10), 1000);
        const offset = (pageNum - 1) * pageSizeNum;
        query += ' LIMIT ? OFFSET ?';
        params.push(pageSizeNum.toString(), offset.toString());
      } else {
        // Just limit without pagination
        const limitNum = Math.min(parseInt(limit, 10), 1000).toString();
        query += ' LIMIT ?';
        params.push(limitNum);
      }

      const [rows] = await this.db.execute(query, params);

      // Get total count for pagination info
      let countQuery = 'SELECT COUNT(*) as total FROM server_metrics WHERE 1=1';
      const countParams = [];
      if (server) {
        countQuery += ' AND server = ?';
        countParams.push(server);
      }
      if (startTime) {
        countQuery += ' AND timestamp >= FROM_UNIXTIME(?)';
        countParams.push(parseInt(startTime, 10));
      }
      if (endTime) {
        countQuery += ' AND timestamp <= FROM_UNIXTIME(?)';
        countParams.push(parseInt(endTime, 10));
      }

      const [countResult] = await this.db.execute(countQuery, countParams);
      const total = countResult[0].total;

      res.json({
        success: true,
        count: rows.length,
        total,
        page: page ? parseInt(page, 10) : undefined,
        pageSize: page ? parseInt(pageSize, 10) : undefined,
        data: rows,
      });
    } catch (error) {
      console.error('❌ Error fetching metrics:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch metrics',
        details: process.env.NODE_ENV === 'development' ? error.message : undefined,
      });
    }
  }

  /**
   * GET /api/metrics/:server
   * Get metrics for a specific server
   */
  async getServerMetrics(req, res) {
    try {
      const { server } = req.params;
      const {
        startTime,
        endTime,
        limit = '100',
        page,
        pageSize = '50',
      } = req.query;

      if (!server) {
        return res.status(400).json({
          success: false,
          error: 'Server identifier is required',
        });
      }

      let query = 'SELECT * FROM server_metrics WHERE server = ?';
      const params = [server];

      // Filter by time range
      if (startTime) {
        query += ' AND timestamp >= FROM_UNIXTIME(?)';
        params.push(parseInt(startTime, 10));
      }

      if (endTime) {
        query += ' AND timestamp <= FROM_UNIXTIME(?)';
        params.push(parseInt(endTime, 10));
      }

      query += ' ORDER BY timestamp DESC';

      // Handle pagination
      if (page) {
        const pageNum = parseInt(page, 10);
        const pageSizeNum = Math.min(parseInt(pageSize, 10), 1000);
        const offset = (pageNum - 1) * pageSizeNum;
        query += ' LIMIT ? OFFSET ?';
        params.push(pageSizeNum.toString(), offset.toString());
      } else {
        const limitNum = Math.min(parseInt(limit, 10), 1000).toString();
        query += ' LIMIT ?';
        params.push(limitNum);
      }

      const [rows] = await this.db.execute(query, params);

      // Get total count
      let countQuery = 'SELECT COUNT(*) as total FROM server_metrics WHERE server = ?';
      const countParams = [server];
      if (startTime) {
        countQuery += ' AND timestamp >= FROM_UNIXTIME(?)';
        countParams.push(parseInt(startTime, 10));
      }
      if (endTime) {
        countQuery += ' AND timestamp <= FROM_UNIXTIME(?)';
        countParams.push(parseInt(endTime, 10));
      }

      const [countResult] = await this.db.execute(countQuery, countParams);
      const total = countResult[0].total;

      res.json({
        success: true,
        server,
        count: rows.length,
        total,
        page: page ? parseInt(page, 10) : undefined,
        pageSize: page ? parseInt(pageSize, 10) : undefined,
        data: rows,
      });
    } catch (error) {
      console.error('❌ Error fetching server metrics:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch server metrics',
        details: process.env.NODE_ENV === 'development' ? error.message : undefined,
      });
    }
  }

  /**
   * GET /api/metrics/stats/summary
   * Get summary statistics for metrics
   */
  async getMetricsSummary(req, res) {
    try {
      const { server, startTime, endTime } = req.query;

      let query = `
        SELECT 
          COUNT(*) as total_records,
          COUNT(DISTINCT server) as unique_servers,
          AVG(cpu_usage) as avg_cpu,
          AVG(mem_usage) as avg_mem,
          AVG(disk_read_mb_per_min) as avg_disk_read,
          AVG(disk_write_mb_per_min) as avg_disk_write,
          AVG(nginx_request_count_per_min) as avg_nginx_requests,
          MAX(timestamp) as latest_timestamp,
          MIN(timestamp) as earliest_timestamp
        FROM server_metrics
        WHERE 1=1
      `;
      const params = [];

      if (server) {
        query += ' AND server = ?';
        params.push(server);
      }

      if (startTime) {
        query += ' AND timestamp >= FROM_UNIXTIME(?)';
        params.push(parseInt(startTime, 10));
      }

      if (endTime) {
        query += ' AND timestamp <= FROM_UNIXTIME(?)';
        params.push(parseInt(endTime, 10));
      }

      const [rows] = await this.db.execute(query, params);
      const stats = rows[0];

      res.json({
        success: true,
        summary: {
          totalRecords: parseInt(stats.total_records),
          uniqueServers: parseInt(stats.unique_servers),
          averages: {
            cpu: stats.avg_cpu ? parseFloat(stats.avg_cpu) : null,
            memory: stats.avg_mem ? parseFloat(stats.avg_mem) : null,
            diskReadMBPerMin: stats.avg_disk_read ? parseFloat(stats.avg_disk_read) : null,
            diskWriteMBPerMin: stats.avg_disk_write ? parseFloat(stats.avg_disk_write) : null,
            nginxRequestsPerMin: stats.avg_nginx_requests ? parseFloat(stats.avg_nginx_requests) : null,
          },
          timeRange: {
            earliest: stats.earliest_timestamp,
            latest: stats.latest_timestamp,
          },
        },
      });
    } catch (error) {
      console.error('❌ Error fetching metrics summary:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch metrics summary',
        details: process.env.NODE_ENV === 'development' ? error.message : undefined,
      });
    }
  }

  /**
   * GET /api/metrics/servers/list
   * Get list of all unique servers that have submitted metrics
   */
  async getServersList(req, res) {
    try {
      const query = `
        SELECT 
          server,
          COUNT(*) as metric_count,
          MAX(timestamp) as latest_metric,
          MIN(timestamp) as earliest_metric
        FROM server_metrics
        GROUP BY server
        ORDER BY latest_metric DESC
      `;

      const [rows] = await this.db.execute(query);

      res.json({
        success: true,
        count: rows.length,
        servers: rows.map(row => ({
          server: row.server,
          metricCount: parseInt(row.metric_count),
          latestMetric: row.latest_metric,
          earliestMetric: row.earliest_metric,
        })),
      });
    } catch (error) {
      console.error('❌ Error fetching servers list:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch servers list',
        details: process.env.NODE_ENV === 'development' ? error.message : undefined,
      });
    }
  }
}

module.exports = MetricsController;

