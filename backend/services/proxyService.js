const tunnel = require('tunnel');
const { performance } = require('perf_hooks');
const http = require('http');
const { default: axios } = require('axios');
const Measurement = require('../models/Measurement');

class ProxyService {
  constructor() {
    this.config = {
      PROXY_PORTS: [10220, 10041],
      PROXY_HOST: 'proxy.soax.com',
      TARGET_PORT: 80,
      TIMEOUT_MS: 10000
    };
    this.targets = [];
    this.lastRefresh = null;
  }

  async getIPList() {
    try {
      const url = "https://slave.host-palace.net/portugal_cdn/get_node_list";
      const response = await axios.get(url, { timeout: 10000 });
      const data = response.data;

      const ipList = data
        .filter(item => typeof item === "object" && item.category === 4)
        .map(item => item.ip);

      console.log(`📡 Fetched ${ipList.length} IPs from API`);
      return ipList;
    } catch (error) {
      console.error('❌ Failed to fetch IP list:', error.message);
      return [];
    }
  }

  async refreshTargets() {
    try {
      console.log('🔄 Refreshing IP targets...');
      const newTargets = await this.getIPList();
      
      if (newTargets.length > 0) {
        const previousCount = this.targets.length;
        this.targets = newTargets;
        this.lastRefresh = new Date();
        
        console.log(`✅ IP list updated: ${previousCount} → ${this.targets.length} targets`);
        return this.targets;
      } else {
        console.log('⚠️  No new targets found, keeping existing list');
        if (this.targets.length === 0) {
          throw new Error('No targets available and refresh failed');
        }
        return this.targets;
      }
    } catch (error) {
      console.error('❌ Error refreshing targets:', error.message);
      if (this.targets.length > 0) {
        console.log('⚠️  Using existing targets due to refresh error');
        return this.targets;
      }
      throw error;
    }
  }

  getTargets() {
    return this.targets;
  }

  measureProxyToTargetLatency(targetHost, targetPort, proxyHost, proxyPort, user, pass, timeout) {
    return new Promise((resolve) => {
      const authString = (user && pass) ? `${user}:${pass}` : '';
      const startTime = performance.now();

      const resultTemplate = {
        target: `${targetHost}:${targetPort}`,
        proxy: `${proxyHost}:${proxyPort}`,
        status: 'pending',
        rtt: null,
        error: null,
        message: null,
        measurement_type: 'http'
      };

      try {
        const proxyConfig = {
          host: proxyHost,
          port: proxyPort,
          headers: { 
            'User-Agent': 'Node.js-Network-Check',
            'Connection': 'close'
          }
        };

        if (authString) {
          proxyConfig.proxyAuth = authString;
        }

        const tunnelingAgent = tunnel.httpOverHttp({ proxy: proxyConfig });

        const requestOptions = {
          method: 'HEAD',
          host: targetHost,
          port: targetPort,
          path: '/',
          agent: tunnelingAgent,
          timeout,
          headers: {
            'User-Agent': 'Node.js-Network-Check',
            'Connection': 'close'
          }
        };

        const req = http.request(requestOptions, (res) => {
          const endTime = performance.now();
          const rtt = (endTime - startTime).toFixed(2);
          resultTemplate.rtt = `${rtt}ms`;

          if (res.statusCode >= 400 && res.statusCode < 500) {
            resultTemplate.status = 'proxy_rejected';
            resultTemplate.error = `HTTP ${res.statusCode}`;
            resultTemplate.message = `Proxy rejected with status ${res.statusCode}`;
          } else {
            resultTemplate.status = 'success';
            resultTemplate.message = `Success - ${res.statusCode}`;
          }

          res.destroy();
          resolve(Measurement.fromNetworkResult(resultTemplate));
        });

        req.on('socket', (socket) => {
          socket.on('connect', () => {
            console.log(`🔌 Socket connected to proxy ${proxyHost}:${proxyPort} for ${targetHost}`);
          });

          socket.on('error', (err) => {
            const duration = (performance.now() - startTime).toFixed(2);
            resultTemplate.rtt = `${duration}ms`;
            resultTemplate.status = 'socket_error';
            resultTemplate.error = err.code || 'SocketError';
            resultTemplate.message = `Socket error: ${err.message}`;
            resolve(Measurement.fromNetworkResult(resultTemplate));
          });
        });

        req.on('error', (err) => {
          const duration = (performance.now() - startTime).toFixed(2);
          resultTemplate.rtt = `${duration}ms`;
          resultTemplate.status = 'failed';
          resultTemplate.error = err.code || 'NetworkError';
          resultTemplate.message = err.message;
          resolve(Measurement.fromNetworkResult(resultTemplate));
        });

        req.on('timeout', () => {
          const duration = (performance.now() - startTime).toFixed(2);
          req.destroy();
          resultTemplate.rtt = `${duration}ms`;
          resultTemplate.status = 'timeout';
          resultTemplate.error = 'ETIMEOUT';
          resultTemplate.message = `Timed out after ${timeout}ms`;
          resolve(Measurement.fromNetworkResult(resultTemplate));
        });

        req.end();

      } catch (e) {
        resultTemplate.status = 'error';
        resultTemplate.error = 'ScriptSetupError';
        resultTemplate.message = e.message;
        resolve(Measurement.fromNetworkResult(resultTemplate));
      }
    });
  }

  // FIXED: Run measurements for BOTH proxy ports simultaneously
  async runMeasurements(databaseService, measurementType = 'http') {
    const startTime = Date.now();
    
    try {
      console.log(`🚀 Starting ${measurementType} measurements at ${new Date().toISOString()}`);
      
      if (this.targets.length === 0) {
        console.log('❌ No IPs available for measurement');
        throw new Error('No IP targets available');
      }

      console.log(`📡 Measuring ${this.targets.length} IPs using ${measurementType} method`);

      // Run measurements for ALL proxy ports in parallel
      const measurementPromises = this.config.PROXY_PORTS.map(async (proxyPort) => {
        console.log(`🔍 Starting measurements via proxy port ${proxyPort}...`);
        
        try {
          const results = await Promise.all(
            this.targets.map(ip => this.measureProxyToTargetLatency(
              ip, 
              this.config.TARGET_PORT, 
              this.config.PROXY_HOST, 
              proxyPort, 
              process.env.PROXY_USER, 
              process.env.PROXY_PASS, 
              this.config.TIMEOUT_MS
            ))
          );

          // Save results to database
          const savePromises = results.map(result => databaseService.saveMeasurement(result));
          const dbResults = await Promise.all(savePromises);
          
          const successfulSaves = dbResults.filter(id => id !== null).length;
          console.log(`💾 Saved ${successfulSaves}/${results.length} measurements for proxy port ${proxyPort}`);
          
          const successCount = results.filter(r => r.status === 'success').length;
          const failedCount = results.length - successCount;
          
          // FIXED: Safe RTT calculation without replace() errors
          const successfulMeasurements = results.filter(r => r.status === 'success' && r.rtt);
          let avgRTT = 0;
          if (successfulMeasurements.length > 0) {
            const totalRTT = successfulMeasurements.reduce((sum, m) => {
              // Safe RTT parsing - handle both string "123.45ms" and number formats
              let rttValue = 0;
              if (typeof m.rtt === 'string') {
                // Remove 'ms' and convert to number safely
                rttValue = parseFloat(m.rtt.replace(/[^\d.]/g, '')) || 0;
              } else if (typeof m.rtt === 'number') {
                rttValue = m.rtt;
              }
              return sum + rttValue;
            }, 0);
            avgRTT = totalRTT / successfulMeasurements.length;
          }
          
          console.log(`📊 Proxy ${proxyPort}: ${successCount} success, ${failedCount} failed, Avg RTT: ${avgRTT.toFixed(2)}ms`);
          
          return {
            proxyPort,
            successCount,
            failedCount,
            avgRTT,
            totalMeasurements: results.length
          };
          
        } catch (proxyError) {
          console.error(`❌ Error with proxy port ${proxyPort}:`, proxyError.message);
          return {
            proxyPort,
            successCount: 0,
            failedCount: this.targets.length,
            avgRTT: 0,
            error: proxyError.message
          };
        }
      });

      // Wait for all proxy ports to complete
      const allResults = await Promise.all(measurementPromises);
      
      const duration = Date.now() - startTime;
      console.log(`✅ ${measurementType.toUpperCase()} measurements completed in ${duration}ms`);
      
      // Log summary
      allResults.forEach(result => {
        if (result.error) {
          console.log(`❌ Proxy ${result.proxyPort}: FAILED - ${result.error}`);
        } else {
          console.log(`✅ Proxy ${result.proxyPort}: ${result.successCount}/${result.totalMeasurements} successful`);
        }
      });
      
    } catch (error) {
      console.error(`❌ Error during ${measurementType} measurements:`, error.message);
      throw error;
    }
  }
}

module.exports = ProxyService;