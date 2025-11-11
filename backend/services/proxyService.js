const tunnel = require('tunnel');
const { performance } = require('perf_hooks');
const http = require('http');
const { default: axios } = require('axios');
const Measurement = require('../models/Measurement');

const REGION_TO_GROUP = {
  Spain: 'portugal',
  Portugal: 'portugal',
  Paris: 'portugal',
  Germany: 'portugal',
  Amsterdam: 'uk',
  UK: 'uk',
  London: 'uk',
  Stockholm: 'uk',
  US_EAST: 'america',
  US_WEST: 'america',
  Canada: 'america',
  Italy: 'america',
};

const GROUP_TO_PORTS = {
  portugal: ['10220', '10038'],
  uk: ['10041'],
  america: ['10079', '10238'],
};

const GROUP_LABELS = {
  portugal: 'Portugal',
  uk: 'United Kingdom',
  america: 'America',
};

class ProxyService {
  constructor() {
    this.config = {
      PROXY_PORTS: [10220, 10041, 10079, 10238, 10038],
      PROXY_HOST: 'proxy.soax.com',
      TARGET_PORT: 80,
      TIMEOUT_MS: 10000
    };
    this.portMetadata = [];
    this.groupLabels = new Map();
    this.targets = [];
    this.targetsByPort = new Map();
    this.groupToIps = new Map();
    this.ipToGroup = new Map();
    this.lastRefresh = null;
  }

  normalizeKey(value) {
    return (value || '').toString().trim();
  }

  setPortMetadata(ports = []) {
    this.portMetadata = Array.isArray(ports) ? ports : [];
    if (this.portMetadata.length > 0) {
      this.config.PROXY_PORTS = this.portMetadata.map((port) => Number(port.portNumber));
    } else {
      this.config.PROXY_PORTS = Object.values(GROUP_TO_PORTS)
        .flat()
        .map((port) => Number(port));
    }
  }

  resolveGroup(region) {
    if (!region) {
      return null;
    }

    const trimmed = String(region).trim();
    if (REGION_TO_GROUP[trimmed]) {
      return REGION_TO_GROUP[trimmed];
    }

    const upper = trimmed.toUpperCase();
    if (REGION_TO_GROUP[upper]) {
      return REGION_TO_GROUP[upper];
    }

    const lower = trimmed.toLowerCase();
    if (REGION_TO_GROUP[lower]) {
      return REGION_TO_GROUP[lower];
    }

    return null;
  }

  getPortsForGroup(group) {
    if (!group) return [];
    const ports = GROUP_TO_PORTS[group];
    if (!ports || ports.length === 0) {
      return [];
    }
    return ports;
  }

  async fetchCategoryFourNodes() {
    const url = 'https://slave.host-palace.net/portugal_cdn/get_node_list';
    const response = await axios.get(url, { timeout: 10000 });
    const data = Array.isArray(response.data) ? response.data : [];

    return data
      .filter(item => typeof item === 'object' && item.category === 4 && item.ip)
      .map(item => ({
        ip: item.ip,
        region: item.region || 'Unknown'
      }));
  }

  groupNodesByPort(nodes) {
    const portMap = new Map();
    const groupMap = new Map();
    const ipGroupMap = new Map();

    if (this.config.PROXY_PORTS.length === 0) {
      console.warn('⚠️ No proxy ports configured; consider adding ports in the database.');
    }

    this.config.PROXY_PORTS.forEach(port => {
      portMap.set(String(port), new Set());
    });

    nodes.forEach(({ ip, region }) => {
      const group = this.resolveGroup(region);
      if (!group) {
        console.warn(`⚠️  Unmapped region "${region}" for IP ${ip}`);
        return;
      }

      const ports = this.getPortsForGroup(group);
      if (!ports || ports.length === 0) {
        console.warn(`⚠️  No ports configured for group "${group}" (region ${region})`);
        return;
      }

      if (!groupMap.has(group)) {
        groupMap.set(group, new Set());
      }
      groupMap.get(group).add(ip);
      ipGroupMap.set(ip, group);

      ports.forEach((port) => {
        const key = String(port);
        if (!portMap.has(key)) {
          portMap.set(key, new Set());
        }
        portMap.get(key).add(ip);
      });
    });

    const groupLabels = new Map();
    groupMap.forEach((_, groupKey) => {
      groupLabels.set(groupKey, GROUP_LABELS[groupKey] || groupKey);
    });

    return {
      portMap,
      groupMap,
      ipGroupMap,
      groupLabels,
    };
  }

  setTargetsFromGrouped({ portMap, groupMap, ipGroupMap, groupLabels }) {
    this.targetsByPort.clear();
    this.groupToIps.clear();
    this.ipToGroup.clear();
    this.groupLabels = new Map(groupLabels || []);

    const allTargets = new Set();

    portMap.forEach((ipSet, port) => {
      const ips = Array.from(ipSet);
      this.targetsByPort.set(String(port), ips);
      ips.forEach(ip => allTargets.add(ip));
    });

    groupMap.forEach((ipSet, group) => {
      this.groupToIps.set(group, new Set(ipSet));
    });

    ipGroupMap.forEach((group, ip) => {
      this.ipToGroup.set(ip, group);
    });

    this.targets = Array.from(allTargets);
  }

  getTargetsForPort(port) {
    const key = String(port);
    return this.targetsByPort.get(key) || [];
  }

  getTargetsForGroup(group) {
    if (!group) return [];
    const ipSet = this.groupToIps.get(group);
    return ipSet ? Array.from(ipSet) : [];
  }

  getGroupForIp(ip) {
    return this.ipToGroup.get(ip) || null;
  }

  getGroupLabel(group) {
    if (!group) return 'Unknown';
    return this.groupLabels.get(group) || GROUP_LABELS[group] || group;
  }

  getAllGroups() {
    return Object.keys(GROUP_LABELS);
  }

  async getIPList() {
    try {
      const nodes = await this.fetchCategoryFourNodes();
      const ipList = nodes.map(node => node.ip);

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
      const nodes = await this.fetchCategoryFourNodes();
      const groupedTargets = this.groupNodesByPort(nodes);
      const newTargets = Array.from(new Set(nodes.map(node => node.ip)));

      if (newTargets.length > 0) {
        const previousCount = this.targets.length;
        this.setTargetsFromGrouped(groupedTargets);
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

  getTargetsByPort() {
    return this.targetsByPort;
  }

  measureProxyToTargetLatency(targetHost, targetPort, proxyHost, proxyPort, user, pass, timeout) {
    const authString = (user && pass) ? `${user}:${pass}` : '';

    const resultTemplate = {
      target: `${targetHost}:${targetPort}`,
      proxy: `${proxyHost}:${proxyPort}`,
      status: 'pending',
      rtt: null,
      error: null,
      message: null,
      measurement_type: 'http'
    };

    const proxyConfig = {
      host: proxyHost,
      port: proxyPort,
      headers: {
        'User-Agent': 'Node.js-Network-Check',
        'Connection': 'keep-alive'
      }
    };

    if (authString) {
      proxyConfig.proxyAuth = authString;
    }

    const tunnelingAgent = tunnel.httpOverHttp({ proxy: proxyConfig });

    const performRequest = () => {
      return new Promise((resolve) => {
        const startTime = performance.now();

        const requestOptions = {
          method: 'HEAD',
          host: targetHost,
          port: targetPort,
          path: '/',
          agent: tunnelingAgent,
          timeout,
          headers: {
            'User-Agent': 'Node.js-Network-Check',
            'Connection': 'keep-alive'
          }
        };

        const req = http.request(requestOptions, (res) => {
          const endTime = performance.now();
          const rtt = (endTime - startTime).toFixed(2);

          let status = 'success';
          let error = null;
          let message = `Success - ${res.statusCode}`;

          if (res.statusCode >= 400 && res.statusCode < 500) {
            status = 'proxy_rejected';
            error = `HTTP ${res.statusCode}`;
            message = `Proxy rejected with status ${res.statusCode}`;
          }

          res.resume();
          resolve({ status, rtt: `${rtt}ms`, error, message });
        });

        req.on('error', (err) => {
          const endTime = performance.now();
          const rtt = (endTime - startTime).toFixed(2);
          resolve({
            status: 'failed',
            rtt: `${rtt}ms`,
            error: err.code || 'NetworkError',
            message: err.message
          });
        });

        req.on('timeout', () => {
          const endTime = performance.now();
          const rtt = (endTime - startTime).toFixed(2);
          req.destroy();
          resolve({
            status: 'timeout',
            rtt: `${rtt}ms`,
            error: 'ETIMEOUT',
            message: `Timed out after ${timeout}ms`
          });
        });

        req.end();
      });
    };

    return (async () => {
      try {
        await performRequest();

        const steadyResult = await performRequest();

        return Measurement.fromNetworkResult({
          ...resultTemplate,
          status: steadyResult.status,
          rtt: steadyResult.rtt,
          error: steadyResult.error,
          message: steadyResult.message
        });
      } catch (error) {
        return Measurement.fromNetworkResult({
          ...resultTemplate,
          status: 'error',
          rtt: null,
          error: 'ScriptSetupError',
          message: error.message
        });
      }
    })();
  }

  // FIXED: Run measurements for BOTH proxy ports simultaneously
  async runMeasurements(databaseService, measurementType = 'http', options = {}) {
    const { refreshTargets = true } = options;
    const startTime = Date.now();

    try {
      if (refreshTargets) {
        try {
          await this.refreshTargets();
        } catch (refreshError) {
          console.error('❌ Failed to refresh targets before measurements:', refreshError.message);

          if (!this.targets || this.targets.length === 0) {
            throw refreshError;
          }

          console.warn('⚠️ Proceeding with existing targets due to refresh failure');
        }
      }

      console.log(`🚀 Starting ${measurementType} measurements at ${new Date().toISOString()}`);

      if (this.targets.length === 0) {
        console.log('❌ No IPs available for measurement');
        throw new Error('No IP targets available');
      }

      console.log(`📡 Measuring ${this.targets.length} unique IPs using ${measurementType} method`);

      // Run measurements for ALL proxy ports in parallel
      const measurementPromises = this.config.PROXY_PORTS.map(async (proxyPort) => {
        console.log(`🔍 Starting measurements via proxy port ${proxyPort}...`);

        try {
          const targetsForPort = this.getTargetsForPort(proxyPort);

          if (targetsForPort.length === 0) {
            console.warn(`⚠️  No targets mapped to proxy port ${proxyPort}, skipping measurements`);
            return {
              proxyPort,
              successCount: 0,
              failedCount: 0,
              avgRTT: 0,
              totalMeasurements: 0
            };
          }

          const results = await Promise.all(
            targetsForPort.map(ip => this.measureProxyToTargetLatency(
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
          const targetsForPort = this.getTargetsForPort(proxyPort);
          return {
            proxyPort,
            successCount: 0,
            failedCount: targetsForPort.length,
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