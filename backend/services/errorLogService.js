const { Client } = require('ssh2');
const { createDbConnection } = require('../config/database');

class ErrorLogService {
  constructor(proxyService) {
    this.db = createDbConnection();
    this.proxyService = proxyService;

    // SSH credentials - you might want to move these to environment variables
    this.sshCredentials = {
      port: 22,
      username: 'root',
      password: '8HLDcia7JXcdCPK' // Consider using SSH keys instead
    };
  }

  // Generate SSH config for each live IP
  async getSSHConfigs() {
    try {
      // Get live IPs from ProxyService
      const ipList = await this.proxyService.getIPList();
      console.log(`🔄 Found ${ipList.length} live IPs for error log collection`);

      // Create SSH config for each IP
      const sshConfigs = ipList.map(ip => ({
        host: ip,
        port: this.sshCredentials.port,
        username: this.sshCredentials.username,
        password: this.sshCredentials.password,
        serverName: `Server-${ip}`
      }));

      return sshConfigs;
    } catch (error) {
      console.error('❌ Error getting SSH configs:', error.message);
      return [];
    }
  }

  // Test if server is alive via SSH
  async testServerAlive(sshConfig) {
    return new Promise((resolve) => {
      const conn = new Client();
      const timeout = setTimeout(() => {
        conn.end();
        resolve({ ...sshConfig, alive: false, error: 'SSH Connection Timeout' });
      }, 10000);

      conn.on('ready', () => {
        clearTimeout(timeout);
        conn.end();
        resolve({ ...sshConfig, alive: true });
      });

      conn.on('error', (err) => {
        clearTimeout(timeout);
        resolve({ ...sshConfig, alive: false, error: err.message });
      });

      conn.connect(sshConfig);
    });
  }

  // Parse Nginx error log line
  parseErrorLogLine(line, serverIp) {
    const logPattern = /^(\d+\/\d+\/\d+\s+\d+:\d+:\d+)\s+\[(\w+)\]\s+(\d+)#(\d+):\s+(?:\*(\d+)\s+)?(.+)$/;
    const match = line.match(logPattern);

    if (!match) return null;

    const [, timestamp, level, , nginxPid, , message] = match;

    // Early return if not error level
    if (level.toLowerCase() !== 'error') {
      return null;
    }

    // Extract client IP if present
    const clientIpMatch = message.match(/client:\s+([\d\.]+)/);
    const clientIp = clientIpMatch ? clientIpMatch[1] : null;

    // Extract upstream if present - return null if no upstream
    const upstreamMatch = message.match(/upstream:\s+"([^"]+)"/);
    const upstream = upstreamMatch ? upstreamMatch[1] : null;

    // Early return if no upstream value
    if (!upstream) {
      return null;
    }

    // Extract server if present
    const serverMatch = message.match(/server:\s+([^,]+)/);
    const server = serverMatch ? serverMatch[1] : null;

    // Extract request if present
    const requestMatch = message.match(/request:\s+"([^"]+)"/);
    const request = requestMatch ? requestMatch[1] : null;

    // Extract host if present
    const hostMatch = message.match(/host:\s+"([^"]+)"/);
    const host = hostMatch ? hostMatch[1] : null;

    return {
      server_ip: serverIp,
      log_level: level.toLowerCase(),
      original_timestamp: new Date(timestamp.replace(/\//g, '-')),
      nginx_pid: nginxPid ? parseInt(nginxPid) : null,
      client_ip: clientIp,
      upstream: upstream,
      server_name: server,
      request: request,
      host: host,
      error_message: message,
      full_log_text: line
    };
  }

  // Get error logs from remote server via SSH
  async getRemoteErrorLogs(sshConfig, sinceTimestamp = null) {
    return new Promise((resolve, reject) => {
      const conn = new Client();
      const logs = [];

      conn.on('ready', () => {
        conn.sftp((err, sftp) => {
          if (err) {
            conn.end();
            return reject(err);
          }

          // Read Nginx error log
          sftp.readFile('/var/log/nginx/error.log', 'utf8', (err, data) => {
            conn.end();

            if (err) {
              return reject(err);
            }

            // Parse each line and filter by timestamp if provided
            const lines = data.split('\n').filter(line => line.trim());

            for (const line of lines) {
              const parsedLog = this.parseErrorLogLine(line, sshConfig.host);

              if (parsedLog) {
                // If sinceTimestamp is provided, only include logs after that time
                if (!sinceTimestamp || parsedLog.original_timestamp > sinceTimestamp) {
                  logs.push(parsedLog);
                }
              }
            }

            console.log(`📝 Server ${sshConfig.host}: Found ${logs.length} logs since ${sinceTimestamp || 'beginning'}`);
            resolve(logs);
          });
        });
      });

      conn.on('error', (err) => {
        reject(err);
      });

      conn.connect(sshConfig);
    });
  }

  // Enhanced method to check if log already exists
  async isDuplicateLog(log) {
    try {
      const query = `
        SELECT COUNT(*) as count FROM error_logs 
        WHERE server_ip = ? 
        AND original_timestamp = ? 
        AND error_message = ?
        AND client_ip = ?
        LIMIT 1
      `;

      const [rows] = await this.db.execute(query, [
        log.server_ip,
        log.original_timestamp,
        log.error_message,
        log.client_ip
      ]);

      return rows[0].count > 0;
    } catch (error) {
      console.error('❌ Error checking duplicate:', error.message);
      return false;
    }
  }

  // Enhanced method to get the latest log timestamp for a server
  async getLatestLogTimestamp(serverIp) {
    try {
      const query = `
        SELECT MAX(original_timestamp) as latest_timestamp 
        FROM error_logs 
        WHERE server_ip = ?
      `;

      const [rows] = await this.db.execute(query, [serverIp]);
      return rows[0].latest_timestamp;
    } catch (error) {
      console.error('❌ Error getting latest timestamp:', error.message);
      return null;
    }
  }

  // Enhanced save method with duplicate checking
  // Enhanced save method with Promise.all for faster saving
  async saveLogsToDatabase(logs) {
    if (logs.length === 0) return 0;

    const query = `
    INSERT INTO error_logs 
    (server_ip, log_level, original_timestamp, nginx_pid, client_ip, upstream, server_name, request, host, error_message, full_log_text)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;

    let savedCount = 0;
    let duplicateCount = 0;
    let filteredCount = 0;

    // Filter logs first
    const filteredLogs = logs.filter(log => {
      // Only save logs with error level and non-empty upstream
      if (log.log_level !== 'error' || !log.upstream) {
        filteredCount++;
        return false;
      }
      return true;
    });

    if (filteredLogs.length === 0) {
      console.log(`⚠️ All ${logs.length} logs were filtered out (not error level or empty upstream)`);
      return 0;
    }

    console.log(`📝 Processing ${filteredLogs.length} logs after filtering...`);

    // Process logs in batches to avoid memory issues
    const BATCH_SIZE = 50;
    const batches = [];

    for (let i = 0; i < filteredLogs.length; i += BATCH_SIZE) {
      batches.push(filteredLogs.slice(i, i + BATCH_SIZE));
    }

    for (const [batchIndex, batch] of batches.entries()) {
      console.log(`🔄 Processing batch ${batchIndex + 1}/${batches.length} (${batch.length} logs)...`);

      const savePromises = batch.map(async (log) => {
        try {
          // Check if this log already exists
          const isDuplicate = await this.isDuplicateLog(log);

          if (isDuplicate) {
            duplicateCount++;
            return null; // Skip duplicate
          }

          // Truncate upstream and request to prevent data too long errors
          const truncatedUpstream = log.upstream && log.upstream.length > 5000
            ? log.upstream.substring(0, 5000) + '... [TRUNCATED]'
            : log.upstream;

          const truncatedRequest = log.request && log.request.length > 5000
            ? log.request.substring(0, 5000) + '... [TRUNCATED]'
            : log.request;

          // Execute the insert
          await this.db.execute(query, [
            log.server_ip,
            log.log_level,
            log.original_timestamp,
            log.nginx_pid,
            log.client_ip,
            truncatedUpstream,
            log.server_name,
            truncatedRequest,
            log.host,
            log.error_message,
            log.full_log_text
          ]);

          return true; // Successfully saved

        } catch (error) {
          if (error.code === 'ER_DUP_ENTRY') {
            duplicateCount++;
            return null; // Skip duplicate
          } else {
            console.error('❌ Error saving log to database:', error.message);
            console.log('Problematic log:', {
              server: log.server_ip,
              timestamp: log.original_timestamp,
              message: log.error_message?.substring(0, 100)
            });
            return false; // Error
          }
        }
      });

      // Wait for all promises in this batch to complete
      const results = await Promise.all(savePromises);

      // Count successful saves
      const batchSaved = results.filter(result => result === true).length;
      savedCount += batchSaved;

      console.log(`✅ Batch ${batchIndex + 1} completed: ${batchSaved} logs saved`);
    }

    // Summary
    if (filteredCount > 0) {
      console.log(`⚠️ Filtered out ${filteredCount} logs (not error level or empty upstream)`);
    }
    if (duplicateCount > 0) {
      console.log(`⚠️ Skipped ${duplicateCount} duplicate logs`);
    }

    console.log(`🎉 Total saved: ${savedCount} logs`);
    return savedCount;
  }

  // Main method to collect error logs from all live servers
  async collectErrorLogs() {
    console.log('🔄 Starting optimized error log collection...');
    const collectionStartTime = new Date();

    try {
      const sshConfigs = await this.getSSHConfigs();

      if (sshConfigs.length === 0) {
        console.log('❌ No live servers found');
        return [{
          server: 'all',
          status: 'no_servers',
          error: 'No live servers available',
          logsSaved: 0
        }];
      }

      console.log(`🔌 Processing ${sshConfigs.length} servers with connection pooling...`);

      // Process servers in batches to avoid overwhelming the system
      const CONCURRENT_LIMIT = 5; // Adjust based on your system capacity
      const batches = [];

      for (let i = 0; i < sshConfigs.length; i += CONCURRENT_LIMIT) {
        batches.push(sshConfigs.slice(i, i + CONCURRENT_LIMIT));
      }

      const allResults = [];

      for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
        const batch = batches[batchIndex];
        console.log(`🔄 Processing batch ${batchIndex + 1}/${batches.length} (${batch.length} servers)...`);

        const batchPromises = batch.map(sshConfig => this.processSingleServer(sshConfig));
        const batchResults = await Promise.allSettled(batchPromises);

        // Extract results from Promise.allSettled
        const successfulResults = batchResults
          .filter(result => result.status === 'fulfilled')
          .map(result => result.value);

        allResults.push(...successfulResults);

        // Small delay between batches to avoid overwhelming
        if (batchIndex < batches.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }

      // Summary
      const totalSaved = allResults.reduce((sum, result) => sum + (result.logsSaved || 0), 0);
      const collectionTime = Date.now() - collectionStartTime.getTime();

      console.log(`🎉 Collection completed in ${collectionTime}ms`);
      console.log(`📊 Total logs saved: ${totalSaved} from ${allResults.length} servers`);

      return allResults;

    } catch (error) {
      console.error('❌ Error in collectErrorLogs:', error.message);
      return [{
        server: 'all',
        status: 'error',
        error: error.message,
        logsSaved: 0
      }];
    }
  }

  // Helper method to process a single server
  async processSingleServer(sshConfig) {
    try {
      // Test if server is alive
      const serverStatus = await this.testServerAlive(sshConfig);

      if (!serverStatus.alive) {
        console.log(`❌ ${sshConfig.host}: Offline - ${serverStatus.error}`);
        return {
          server: sshConfig.host,
          status: 'offline',
          error: serverStatus.error,
          logsSaved: 0
        };
      }

      // Get latest timestamp and logs in parallel
      const [latestTimestamp, logs] = await Promise.all([
        this.getLatestLogTimestamp(sshConfig.host),
        this.getRemoteErrorLogs(sshConfig)
      ]);

      console.log(`📅 ${sshConfig.host}: ${logs.length} logs found`);

      if (logs.length === 0) {
        return {
          server: sshConfig.host,
          status: 'no_new_logs',
          logsSaved: 0,
          latestTimestamp: latestTimestamp
        };
      }

      // Filter logs
      const filteredLogs = logs.filter(log =>
        log.log_level === 'error' &&
        log.upstream &&
        log.upstream.trim() !== ''
      );

      if (filteredLogs.length === 0) {
        return {
          server: sshConfig.host,
          status: 'no_relevant_logs',
          logsSaved: 0,
          totalFound: logs.length,
          filteredOut: logs.length
        };
      }

      // Save to database
      const savedCount = await this.saveLogsToDatabase(filteredLogs);

      console.log(`✅ ${sshConfig.host}: ${savedCount}/${filteredLogs.length} logs saved`);
      return {
        server: sshConfig.host,
        status: 'success',
        logsSaved: savedCount,
        totalFound: logs.length,
        filteredOut: logs.length - filteredLogs.length,
        relevantLogs: filteredLogs.length
      };

    } catch (error) {
      console.error(`❌ ${sshConfig.host}: Error - ${error.message}`);
      return {
        server: sshConfig.host,
        status: 'error',
        error: error.message,
        logsSaved: 0
      };
    }
  }
  // Get error logs from database
  async getErrorLogs(filters = {}) {
    let query = `
      SELECT 
        id,
        server_ip,
        log_level,
        original_timestamp,
        nginx_pid,
        client_ip,
        upstream,
        server_name,
        request,
        host,
        error_message,
        full_log_text,
        created_at
      FROM error_logs 
      WHERE log_level = 'error' 
      AND upstream IS NOT NULL 
      AND upstream != ''
    `;
    const params = [];

    if (filters.server_ip) {
      query += ' AND server_ip = ?';
      params.push(filters.server_ip);
    }

    if (filters.log_level) {
      query += ' AND log_level = ?';
      params.push(filters.log_level);
    }

    if (filters.start_date) {
      query += ' AND DATE(original_timestamp) >= ?';
      params.push(filters.start_date);
    }

    if (filters.end_date) {
      query += ' AND DATE(original_timestamp) <= ?';
      params.push(filters.end_date);
    }

    query += ' ORDER BY original_timestamp DESC LIMIT 1000';

    try {
      const [rows] = await this.db.execute(query, params);
      return rows;
    } catch (error) {
      console.error('❌ Database error fetching error logs:', error.message);
      throw error;
    }
  }

  // Get error statistics
  async getErrorStats() {
    const query = `
      SELECT 
        server_ip,
        log_level,
        COUNT(*) as count,
        DATE(original_timestamp) as date
      FROM error_logs 
      WHERE original_timestamp >= DATE_SUB(NOW(), INTERVAL 7 DAY)
      GROUP BY server_ip, log_level, DATE(original_timestamp)
      ORDER BY date DESC, count DESC
    `;

    try {
      const [rows] = await this.db.execute(query);
      return rows;
    } catch (error) {
      console.error('❌ Error fetching error stats:', error.message);
      throw error;
    }
  }
}

module.exports = ErrorLogService;