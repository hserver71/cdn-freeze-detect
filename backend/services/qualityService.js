const TelegramService = require('./telegramService');

const MIN_IN_MS = 60 * 1000;

const FAILURE_STATUSES = new Set([
  'timeout',
  'failed',
  'socket_error',
  'proxy_rejected',
  'error',
]);

const DATA_CENTER_ALIASES = [
  { match: (company) => company?.toLowerCase() === 'melbikomas uab', label: 'Delta' },
  { match: (company) => company?.toLowerCase() === 'amazon.com, inc', label: 'Aws' },
  { match: (company) => company?.toLowerCase() === 'digitalocean, llc', label: 'DO' },
  {
    match: (company) =>
      !company ||
      company.toLowerCase() === 'unknown' ||
      company.toLowerCase().startsWith('mohsen nikk'),
    label: 'Ramda',
  },
  { match: (company) => company?.toLowerCase() === 'colocationx ltd', label: 'Pi' },
  { match: (company) => company?.toLowerCase() === 'rackdog, llc', label: 'OFF' },
];

const resolveDataCenterName = (company) => {
  const trimmed = company?.trim() || '';
  const mapping = DATA_CENTER_ALIASES.find((entry) => entry.match(trimmed));
  if (mapping) {
    return mapping.label;
  }
  return trimmed || 'Unknown';
};

const DEFAULT_CONFIG = {
  aggregationIntervalMs: 4 * MIN_IN_MS,
  windowMinutes: 15,
  normalMeasurementIntervalMs: 4 * MIN_IN_MS,
  thresholds: {
    ttl: {
      warningSuccessRate: 0.95,
      badSuccessRate: 0.8,
      warningAvgRttMs: 250,
      badAvgRttMs: 1500,
      warningTimeoutRate: 0.1,
      badTimeoutRate: 0.25,
      blockedSampleMinimum: 2,
      highRttMs: 1500,
      highTimeoutRate: 0.15,
      minBadSuccessRate: 0.85,
      minTrafficForBadMbps: 30,
    },
    bandwidth: {
      warningAvgMbps: 8,
      badAvgMbps: 4,
      lowTrafficMbps: 6,
      minSamples: 3,
    },
  },
};

const formatDateUtc = (date) => {
  const pad = (val) => String(val).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
};

const formatHumanUtc = (date) => {
  return formatDateUtc(date);
};

class QualityService {
  constructor(db, proxyService, telegramService = null, config = {}) {
    this.db = db;
    this.proxyService = proxyService;
    this.telegramService = telegramService;
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
      thresholds: {
        ...DEFAULT_CONFIG.thresholds,
        ...(config.thresholds || {}),
        ttl: {
          ...DEFAULT_CONFIG.thresholds.ttl,
          ...((config.thresholds && config.thresholds.ttl) || {}),
        },
        bandwidth: {
          ...DEFAULT_CONFIG.thresholds.bandwidth,
          ...((config.thresholds && config.thresholds.bandwidth) || {}),
        },
      },
    };

    this.timer = null;
    this.isRunning = false;
    this.currentWindowStart = null;
    this.currentStats = null;
    this.currentEmergencyState = {
      active: false,
      since: null,
      reasons: [],
      updatedAt: null,
    };
    this.currentMeasurementIntervalMs = this.config.normalMeasurementIntervalMs;
    this.emergencyListeners = new Set();
    this.portMetadata = [];
    this.portMetadataMap = new Map();
  }

  setPortMetadata(ports = []) {
    this.portMetadata = ports;
    this.portMetadataMap = new Map(
      ports.map((port) => [Number(port.portNumber), port])
    );
  }

  getPortMetadata(portNumber) {
    return this.portMetadataMap.get(Number(portNumber)) || null;
  }

  formatPortShort(portNumber) {
    const metadata = this.getPortMetadata(portNumber);
    if (!metadata) {
      return `port ${portNumber}`;
    }
    const countryShort = metadata.countryShort || metadata.country;
    const providerShort = metadata.providerShort || metadata.provider;
    const labelParts = [];
    if (countryShort) labelParts.push(countryShort);
    if (providerShort) labelParts.push(providerShort);
    const label = labelParts.length > 0 ? labelParts.join('·') : `port ${portNumber}`;
    return `${label}`;
  }

  formatPortLong(portNumber) {
    const metadata = this.getPortMetadata(portNumber);
    if (!metadata) {
      return `Port ${portNumber}`;
    }
    const short = this.formatPortShort(portNumber);
    return `${short} (${portNumber})`;
  }

  async fetchCompanyMap(hosts) {
    const companyMap = new Map();
    if (!Array.isArray(hosts) || hosts.length === 0) {
      return companyMap;
    }

    const uniqueHosts = Array.from(new Set(hosts.filter(Boolean)));
    if (uniqueHosts.length === 0) {
      return companyMap;
    }

    const placeholders = uniqueHosts.map(() => '?').join(',');
    try {
      const [rows] = await this.db.execute(
        `SELECT ip, company FROM ip_company_cache WHERE ip IN (${placeholders})`,
        uniqueHosts
      );
      rows.forEach((row) => {
        companyMap.set(row.ip, row.company || null);
      });
    } catch (error) {
      console.error('❌ Failed to load company names:', error.message);
    }

    return companyMap;
  }

  async fetchRecentStatuses(nodeIdentifiers) {
    const statusMap = new Map();
    if (!Array.isArray(nodeIdentifiers) || nodeIdentifiers.length === 0) {
      return statusMap;
    }

    const placeholders = nodeIdentifiers.map(() => '(?,?,?)').join(',');
    const params = [];
    nodeIdentifiers.forEach((node) => {
      params.push(node.proxyPort, node.targetHost, node.targetPort);
    });

    const query = `
      SELECT proxy_port, target_host, target_port, status, rn
      FROM (
        SELECT 
          proxy_port,
          target_host,
          target_port,
          status,
          ROW_NUMBER() OVER (
            PARTITION BY proxy_port, target_host, target_port
            ORDER BY created_at DESC
          ) AS rn
        FROM measurements
        WHERE (proxy_port, target_host, target_port) IN (${placeholders})
      ) ranked
      WHERE rn <= 2
    `;

    try {
      const [rows] = await this.db.execute(query, params);
      rows.forEach((row) => {
        const key = `${row.proxy_port}|${row.target_host}|${row.target_port}`;
        const list = statusMap.get(key) || [];
        const index = Number(row.rn) - 1;
        list[index] = row.status;
        statusMap.set(key, list);
      });
    } catch (error) {
      console.error('❌ Failed to load recent measurement statuses:', error.message);
    }

    return statusMap;
  }

  getCurrentSnapshot() {
    if (!this.currentStats) {
      return null;
    }

    const cloneNodes = (nodes) =>
      nodes.map((node) => ({
        proxyPort: node.proxyPort,
        targetHost: node.targetHost,
        targetPort: node.targetPort,
        company: node.company || null,
        sampleCount: node.sampleCount,
        successCount: node.successCount,
        timeoutCount: node.timeoutCount,
        failureCount: node.failureCount ?? node.timeoutCount,
        rawTimeoutCount: node.rawTimeoutCount ?? null,
        errorCount: node.errorCount,
        successRate: node.successRate,
        timeoutRate: node.timeoutRate,
        failureRate: node.failureRate ?? node.timeoutRate,
        avgRtt: node.avgRtt,
        maxRtt: node.maxRtt,
        isLive: node.isLive,
        blocked: node.blocked,
        quality: node.quality,
        bandwidthInfo: node.bandwidthInfo
          ? {
              proxyPort: node.bandwidthInfo.proxyPort,
              ipAddress: node.bandwidthInfo.ipAddress,
              sampleCount: node.bandwidthInfo.sampleCount,
              avgBandwidth: node.bandwidthInfo.avgBandwidth,
              maxBandwidth: node.bandwidthInfo.maxBandwidth,
              quality: node.bandwidthInfo.quality,
              isLive: node.bandwidthInfo.isLive,
              lastSeen: node.bandwidthInfo.lastSeen
                ? new Date(node.bandwidthInfo.lastSeen).toISOString()
                : null,
            }
          : null,
        lastSeen: node.lastSeen ? node.lastSeen.toISOString() : null,
      }));

    const cloneBandwidthNodes = (nodes) =>
      nodes.map((node) => ({
        proxyPort: node.proxyPort,
        ipAddress: node.ipAddress,
        sampleCount: node.sampleCount,
        avgBandwidth: node.avgBandwidth,
        maxBandwidth: node.maxBandwidth,
        quality: node.quality,
        isLive: node.isLive,
        lastSeen: node.lastSeen ? node.lastSeen.toISOString() : null,
      }));

    const snapshot = {
      windowStart: this.currentStats.windowStart.toISOString(),
      windowEnd: this.currentStats.windowEnd.toISOString(),
      ttl: {
        totalTargets: this.currentStats.ttl.totalTargets,
        totalSamples: this.currentStats.ttl.totalSamples,
        totalSuccess: this.currentStats.ttl.totalSuccess,
        totalTimeouts: this.currentStats.ttl.totalTimeouts,
        failureRate: this.currentStats.ttl.failureRate,
        badRate: this.currentStats.ttl.badRate,
        badNodes: cloneNodes(this.currentStats.ttl.badNodes),
        blockedNodes: cloneNodes(this.currentStats.ttl.blockedNodes),
      },
      bandwidth: {
        totalIps: this.currentStats.bandwidth.totalIps,
        totalTrafficMbps: this.currentStats.bandwidth.totalTrafficMbps,
        badNodes: cloneBandwidthNodes(this.currentStats.bandwidth.badNodes),
      },
    };

    // attach company info using the cached map for convenience
    const ipInfoService = require('./ipInfoService');
    const enrichNodesWithCompany = (nodes) => {
      if (!Array.isArray(nodes) || nodes.length === 0) {
        return;
      }
      nodes.forEach((node) => {
        if (!node.company && node.targetHost) {
          const cached = ipInfoService.getCompanyFromCache
            ? ipInfoService.getCompanyFromCache(node.targetHost)
            : null;
          if (cached && cached.company) {
            node.company = cached.company;
          }
        }
      });
    };

    enrichNodesWithCompany(snapshot.ttl.badNodes);
    enrichNodesWithCompany(snapshot.ttl.blockedNodes);

    return snapshot;
  }

  buildTelegramSummary(snapshot) {
    if (!snapshot || !snapshot.ttl) {
      return '';
    }

    const lines = [];
    const blockedNodes = Array.isArray(snapshot.ttl.blockedNodes) ? snapshot.ttl.blockedNodes : [];
    const badNodes = Array.isArray(snapshot.ttl.badNodes) ? snapshot.ttl.badNodes : [];

    if (blockedNodes.length > 0) {
      lines.push(`*${TelegramService.escape('Blocked Nodes')}*`);
      const groupedByHost = new Map();

      blockedNodes.forEach((node) => {
        const host = node.targetHost || 'unknown';
        if (!groupedByHost.has(host)) {
          groupedByHost.set(host, {
            ports: new Set(),
            dc: resolveDataCenterName(node.company),
          });
        }
        const entry = groupedByHost.get(host);
        entry.ports.add(node.proxyPort);
        if (!entry.dc && node.company) {
          entry.dc = resolveDataCenterName(node.company);
        }
      });

      const sortedHosts = Array.from(groupedByHost.entries()).sort(([hostA], [hostB]) =>
        hostA.localeCompare(hostB)
      );

      sortedHosts.forEach(([host, info]) => {
        const hostDisplay = host.includes(':80') ? host.replace(':80', '') : host;
        const dcLabel = info.dc || 'Unknown';
        const portList = Array.from(info.ports)
          .sort((a, b) => Number(a) - Number(b))
          .map((port) => this.formatPortShort(port))
          .join(', ');
        const line = `${hostDisplay} (${dcLabel}) — ${portList}`;
        lines.push(`• ${TelegramService.escape(line)}`);
      });
    }

    if (badNodes.length > 0) {
      lines.push(`*${TelegramService.escape('Bad Nodes')}*`);
      const sortedBad = [...badNodes]
        .sort((a, b) => {
          const rttA = a.avgRtt ?? 0;
          const rttB = b.avgRtt ?? 0;
          return rttB - rttA;
        })
        .slice(0, 10);

      sortedBad.forEach((node) => {
        const dc = resolveDataCenterName(node.company);
        const host = node.targetHost || 'unknown';
        const hostWithPort =
          node.targetPort && Number(node.targetPort) !== 80
            ? `${host}:${node.targetPort}`
            : host.includes(':80')
            ? host.replace(':80', '')
            : host;
        const rtt =
          node.avgRtt !== null && node.avgRtt !== undefined
            ? `${Math.round(Number(node.avgRtt))} ms`
            : 'n/a';
        const bandwidth =
          node.bandwidthInfo && node.bandwidthInfo.avgBandwidth !== null && node.bandwidthInfo.avgBandwidth !== undefined
            ? `${Number(node.bandwidthInfo.avgBandwidth).toFixed(2)} Mbps`
            : 'n/a';
        const portLabel = this.formatPortShort(node.proxyPort);
        const line = `${hostWithPort} (${dc}) | ${portLabel} | ${rtt} | ${bandwidth}`;
        lines.push(`• ${TelegramService.escape(line)}`);
      });
    }

    return lines.join('\n').trim();
  }

  buildDailyAnalysisMessage(analysis) {
    if (!analysis) {
      return '';
    }

    const lines = [];
    const formatRange = (value) => {
      if (!value) {
        return '—';
      }
      try {
        return new Date(value).toISOString().replace('T', ' ').replace('Z', '');
      } catch {
        return value;
      }
    };

    lines.push(`*${TelegramService.escape('Daily Quality Summary')}*`);
    lines.push(
      TelegramService.escape(
        `${formatRange(analysis.windowStart)} → ${formatRange(analysis.windowEnd)}`
      )
    );

    const hasPorts = Array.isArray(analysis.ports) && analysis.ports.length > 0;

    if (hasPorts) {
      analysis.ports.forEach((portSummary) => {
        const headerLabel =
          portSummary.portLabel && portSummary.portLabel !== `port ${portSummary.proxyPort}`
            ? `${portSummary.portLabel} (${portSummary.proxyPort})`
            : `Port ${portSummary.proxyPort}`;

        lines.push('');
        lines.push(`*${TelegramService.escape(headerLabel)}*`);

        if (portSummary.totalBlockedMinutes > 0) {
          lines.push(
            TelegramService.escape(`Total blocked: ${portSummary.totalBlockedMinutes} min`)
          );
        }

        if (portSummary.topBadNodes && portSummary.topBadNodes.length > 0) {
          lines.push(TelegramService.escape('Bad nodes:'));
          portSummary.topBadNodes.forEach((node) => {
            const host =
              node.targetPort && Number(node.targetPort) !== 80
                ? `${node.targetHost}:${node.targetPort}`
                : node.targetHost;
            const dc = resolveDataCenterName(node.dataCenter);
            const rtt =
              node.avgRttMs !== null && node.avgRttMs !== undefined
                ? `${Math.round(Number(node.avgRttMs))} ms`
                : 'n/a';
            const traffic =
              node.avgTrafficMbps !== null && node.avgTrafficMbps !== undefined
                ? `${Number(node.avgTrafficMbps).toFixed(2)} Mbps`
                : 'n/a';
            const failurePercent =
              node.failureRate !== null && node.failureRate !== undefined
                ? `${(Number(node.failureRate) * 100).toFixed(1)}%`
                : 'n/a';

            const line = `${host} (${dc}) | ${rtt} | ${traffic} | fail ${failurePercent}`;
            lines.push(`• ${TelegramService.escape(line)}`);
          });
        } else {
          lines.push(`• ${TelegramService.escape('No degraded nodes detected')}`);
        }

        if (portSummary.blockedNodes && portSummary.blockedNodes.length > 0) {
          const maxBlockedEntries = 10;
          const blockedList =
            portSummary.blockedNodes.length > maxBlockedEntries
              ? portSummary.blockedNodes.slice(0, maxBlockedEntries)
              : portSummary.blockedNodes;
          lines.push(TelegramService.escape('Blocked nodes:'));
          blockedList.forEach((node) => {
            const host =
              node.targetPort && Number(node.targetPort) !== 80
                ? `${node.targetHost}:${node.targetPort}`
                : node.targetHost;
            const dc = resolveDataCenterName(node.dataCenter);
            const line = `${host} (${dc}) • ${node.blockedMinutes} min`;
            lines.push(`• ${TelegramService.escape(line)}`);
          });
          if (portSummary.blockedNodes.length > blockedList.length) {
            lines.push(
              TelegramService.escape(
                `…and ${portSummary.blockedNodes.length - blockedList.length} more blocked nodes`
              )
            );
          }
        }
      });
    }

    return lines.join('\n').trim();
  }

  async sendTelegramSummary({ chatId = null } = {}) {
    if (!this.telegramService || !this.telegramService.isEnabled()) {
      throw new Error('Telegram service is not enabled');
    }

    const snapshot = this.getCurrentSnapshot();
    if (!snapshot) {
      throw new Error('Quality snapshot not available');
    }

    const message = this.buildTelegramSummary(snapshot);
    if (!message) {
      return { ok: false, reason: 'empty_message' };
    }

    const sent = chatId
      ? await this.telegramService.sendToChat(chatId, message)
      : await this.telegramService.sendMessage(message);

    return { ok: Boolean(sent && sent.ok), error: sent && !sent.ok ? sent.error : null };
  }

  getEmergencyState() {
    return {
      active: this.currentEmergencyState.active,
      reasons: [...this.currentEmergencyState.reasons],
      since: this.currentEmergencyState.since
        ? this.currentEmergencyState.since.toISOString()
        : null,
      updatedAt: this.currentEmergencyState.updatedAt
        ? this.currentEmergencyState.updatedAt.toISOString()
        : null,
      currentMeasurementIntervalMs: this.currentMeasurementIntervalMs,
    };
  }

  getCurrentMeasurementIntervalMs() {
    return this.currentMeasurementIntervalMs;
  }

  onEmergencyChange(callback) {
    if (typeof callback === 'function') {
      this.emergencyListeners.add(callback);
    }
  }

  removeEmergencyListener(callback) {
    this.emergencyListeners.delete(callback);
  }

  start() {
    if (this.timer) {
      return;
    }

    console.log('📊 QualityService aggregation started');
    this.timer = setInterval(() => {
      this.runAggregation().catch((error) => {
        console.error('❌ QualityService aggregation error:', error.message);
      });
    }, this.config.aggregationIntervalMs);

    // run immediately on start
    this.runAggregation().catch((error) => {
      console.error('❌ Initial QualityService aggregation error:', error.message);
    });
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async runAggregation(reason = 'scheduled') {
    if (this.isRunning) {
      console.log('⏳ QualityService aggregation already running, skipping...');
      return;
    }

    this.isRunning = true;

    try {
      const windowEnd = this.roundToInterval(new Date());
      const windowStart = new Date(windowEnd.getTime() - this.config.windowMinutes * MIN_IN_MS);

      const windowStartStr = formatDateUtc(windowStart);
      const windowEndStr = formatDateUtc(windowEnd);

      const liveTargetsByPort = new Map();
      (this.proxyService?.config?.PROXY_PORTS || []).forEach((port) => {
        const portKey = Number(port);
        const targets = this.proxyService.getTargetsForPort(portKey) || [];
        liveTargetsByPort.set(
          portKey,
          new Set(targets)
        );
      });

      const bandwidthSnapshots = await this.buildBandwidthSnapshots(windowStartStr, windowEndStr, liveTargetsByPort);
      const ttlSnapshots = await this.buildTtlSnapshots(
        windowStartStr,
        windowEndStr,
        liveTargetsByPort,
        bandwidthSnapshots.byIp
      );

      if (ttlSnapshots.insertRows.length > 0) {
        await this.saveTtlSnapshots(ttlSnapshots.insertRows);
      }
      if (bandwidthSnapshots.insertRows.length > 0) {
        await this.saveBandwidthSnapshots(bandwidthSnapshots.insertRows);
      }

      const stats = this.calculateStats({
        windowStart,
        windowEnd,
        ttl: ttlSnapshots.summary,
        bandwidth: bandwidthSnapshots.summary,
      });

      this.currentWindowStart = windowStart;
      this.currentStats = stats;

      this.updateEmergencyState(stats, reason);
    } catch (error) {
      console.error('❌ QualityService aggregation failure:', error.message);
    } finally {
      this.isRunning = false;
    }
  }

  roundToInterval(date) {
    const interval = this.config.aggregationIntervalMs;
    const timestamp = date.getTime();
    return new Date(Math.floor(timestamp / interval) * interval);
  }

  async buildTtlSnapshots(windowStartStr, windowEndStr, liveTargetsByPort, bandwidthInfoMap = new Map()) {
    const ttlQuery = `
      SELECT 
        proxy_port,
        target_host,
        target_port,
        COUNT(*) AS sample_count,
        SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success_count,
        SUM(CASE WHEN status = 'timeout' THEN 1 ELSE 0 END) AS timeout_count,
        SUM(
          CASE
            WHEN status IN ('timeout','failed','socket_error','proxy_rejected','error') THEN 1
            ELSE 0
          END
        ) AS failure_count,
        SUM(CASE WHEN status NOT IN ('success','timeout') THEN 1 ELSE 0 END) AS error_count,
        AVG(
          CASE
            WHEN status = 'success' AND rtt_ms IS NOT NULL THEN rtt_ms
            ELSE NULL
          END
        ) AS avg_rtt_ms,
        MAX(
          CASE
            WHEN status = 'success' AND rtt_ms IS NOT NULL THEN rtt_ms
            ELSE NULL
          END
        ) AS max_rtt_ms,
        MAX(created_at) AS last_seen
      FROM measurements
      WHERE created_at >= ? AND created_at < ?
      GROUP BY proxy_port, target_host, target_port
    `;

    const [rows] = await this.db.execute(ttlQuery, [windowStartStr, windowEndStr]);

    const companyMap = await this.fetchCompanyMap(rows.map((row) => row.target_host));
    const nodeIdentifiers = rows.map((row) => ({
      proxyPort: Number(row.proxy_port),
      targetHost: row.target_host,
      targetPort: Number(row.target_port),
    }));
    const recentStatusMap = await this.fetchRecentStatuses(nodeIdentifiers);

    const summary = {
      totalTargets: 0,
      totalSamples: 0,
      totalSuccess: 0,
      totalTimeouts: 0,
      badNodes: [],
      blockedNodes: [],
    };
    const nodesByPort = new Map();

    rows.forEach((row) => {
      const sampleCount = Number(row.sample_count) || 0;
      if (sampleCount === 0) {
        return;
      }

      const successCount = Number(row.success_count) || 0;
      const timeoutCount = Number(row.timeout_count) || 0;
      const failureCountRaw = Number(row.failure_count);
      const failureCount = Number.isFinite(failureCountRaw)
        ? failureCountRaw
        : Math.max(sampleCount - successCount, 0);
      const errorCount = Number(row.error_count) || 0;
      const avgRtt = row.avg_rtt_ms !== null ? Number(row.avg_rtt_ms) : null;
      const maxRtt = row.max_rtt_ms !== null ? Number(row.max_rtt_ms) : null;
      const successRate = sampleCount > 0 ? successCount / sampleCount : 0;
      const failureRate = sampleCount > 0 ? failureCount / sampleCount : 0;

      const proxyPort = Number(row.proxy_port);
      const targetHost = row.target_host;
      const targetPort = Number(row.target_port);
      const lastSeen = row.last_seen ? new Date(row.last_seen) : null;
      const liveTargets = liveTargetsByPort.get(proxyPort) || new Set();
      const isLive = liveTargets.has(targetHost);
      const bandwidthInfo = bandwidthInfoMap.get(targetHost) || bandwidthInfoMap.get(`${targetHost}:${targetPort}`) || null;
      const nodeKey = `${proxyPort}|${targetHost}|${targetPort}`;
      const recentStatuses = recentStatusMap.get(nodeKey) || [];
      const latestStatus = recentStatuses[0] || null;
      const secondStatus = recentStatuses[1] || null;
      const isBlocked =
        latestStatus !== 'success' &&
        latestStatus &&
        secondStatus &&
        FAILURE_STATUSES.has(latestStatus) &&
        FAILURE_STATUSES.has(secondStatus);
      const quality = this.classifyTtl(successRate, avgRtt, failureRate, sampleCount, isBlocked);
      const isBad = this.isBadTtlNode({
        successRate,
        avgRtt,
        maxRtt,
        failureRate,
        sampleCount,
        isBlocked,
        bandwidthInfo,
      });

      const companyName = companyMap.get(targetHost) || null;
      const dataCenter = resolveDataCenterName(companyName);
      const nodeInfo = {
        proxyPort,
        targetHost,
        targetPort,
        company: companyName,
        dataCenter,
        sampleCount,
        successCount,
        timeoutCount: failureCount,
        failureCount,
        rawTimeoutCount: timeoutCount,
        errorCount,
        successRate,
        timeoutRate: failureRate,
        failureRate,
        avgRtt,
        maxRtt,
        quality,
        isLive,
        blocked: isBlocked,
        bandwidthInfo,
        lastSeen,
        recentStatuses,
        portInfo: this.getPortMetadata(proxyPort),
        portLabel: this.formatPortShort(proxyPort),
      };

      if (!nodesByPort.has(proxyPort)) {
        nodesByPort.set(proxyPort, []);
      }
      nodesByPort.get(proxyPort).push({
        insertRow: [
          proxyPort,
          targetHost,
          targetPort,
          windowStartStr,
          windowEndStr,
          sampleCount,
          successCount,
          failureCount,
          errorCount,
          avgRtt,
          maxRtt,
          quality,
        ],
        nodeInfo,
        isBad,
        isBlocked,
        sampleCount,
        successCount,
        failureCount,
      });
    });

    const insertRows = [];
    nodesByPort.forEach((records, proxyPort) => {
      const totalNodes = records.length;
      const blockedNodesCount = records.filter((record) => record.isBlocked).length;
      if (totalNodes > 0 && blockedNodesCount / totalNodes > 0.5) {
        console.warn(
          `⚠️ Ignoring TTL measurements for proxy port ${proxyPort}: ${blockedNodesCount}/${totalNodes} nodes blocked (assuming proxy issue)`
        );
        return;
      }

      records.forEach((record) => {
        insertRows.push(record.insertRow);
        summary.totalTargets += 1;
        summary.totalSamples += record.sampleCount;
        summary.totalSuccess += record.successCount;
        summary.totalTimeouts += record.failureCount;

        if (record.isBad && !record.isBlocked) {
          summary.badNodes.push(record.nodeInfo);
        }
        if (record.nodeInfo.blocked) {
          summary.blockedNodes.push(record.nodeInfo);
        }
      });
    });

    summary.badNodes.sort((a, b) => (b.avgRtt || 0) - (a.avgRtt || 0));
    summary.blockedNodes.sort((a, b) => b.sampleCount - a.sampleCount);

    return { insertRows, summary };
  }

  async buildBandwidthSnapshots(windowStartStr, windowEndStr, liveTargetsByPort) {
    const bandwidthQuery = `
      SELECT 
        proxy_port,
        ip_address,
        COUNT(*) AS sample_count,
        AVG(up_bandwidth) AS avg_bandwidth,
        MAX(up_bandwidth) AS max_bandwidth,
        MAX(timestamp) AS last_seen
      FROM bandwidth_measurements
      WHERE timestamp >= ? AND timestamp < ?
      GROUP BY proxy_port, ip_address
    `;

    const [rows] = await this.db.execute(bandwidthQuery, [windowStartStr, windowEndStr]);

    const insertRows = [];
    const summary = {
      totalIps: 0,
      badNodes: [],
      totalTrafficMbps: 0,
    };
    const byIp = new Map();

    rows.forEach((row) => {
      const sampleCount = Number(row.sample_count) || 0;
      if (sampleCount === 0) {
        return;
      }

      const avgBandwidth = row.avg_bandwidth !== null ? Number(row.avg_bandwidth) : null;
      const maxBandwidth = row.max_bandwidth !== null ? Number(row.max_bandwidth) : null;
      const proxyPort = Number(row.proxy_port);
      const ipAddress = row.ip_address;
      const liveTargets = liveTargetsByPort.get(proxyPort) || new Set();
      const isLive = liveTargets.has(ipAddress);
      const lastSeen = row.last_seen ? new Date(row.last_seen) : null;

      const quality = this.classifyBandwidth(avgBandwidth, sampleCount);

      const nodeInfo = {
        proxyPort,
        ipAddress,
        sampleCount,
        avgBandwidth,
        maxBandwidth,
        quality,
        isLive,
        lastSeen,
        portInfo: this.getPortMetadata(proxyPort),
        portLabel: this.formatPortShort(proxyPort),
      };

      byIp.set(ipAddress, nodeInfo);

      insertRows.push([
        proxyPort,
        ipAddress,
        windowStartStr,
        windowEndStr,
        sampleCount,
        avgBandwidth,
        maxBandwidth,
        quality,
      ]);

      summary.totalIps += 1;
      if (avgBandwidth !== null) {
        summary.totalTrafficMbps += avgBandwidth;
      }

      if (quality === 'bad') {
        summary.badNodes.push(nodeInfo);
      }
    });

    summary.badNodes.sort((a, b) => (a.avgBandwidth || 0) - (b.avgBandwidth || 0));

    return { insertRows, summary, byIp };
  }

  async saveTtlSnapshots(rows) {
    if (!rows || rows.length === 0) {
      return;
    }

    const sql = `
      INSERT INTO ttl_quality_snapshots
        (proxy_port, target_host, target_port, window_start, window_end, sample_count, success_count, timeout_count, error_count, avg_rtt_ms, max_rtt_ms, quality)
      VALUES ?
      ON DUPLICATE KEY UPDATE
        window_end = VALUES(window_end),
        sample_count = VALUES(sample_count),
        success_count = VALUES(success_count),
        timeout_count = VALUES(timeout_count),
        error_count = VALUES(error_count),
        avg_rtt_ms = VALUES(avg_rtt_ms),
        max_rtt_ms = VALUES(max_rtt_ms),
        quality = VALUES(quality),
        created_at = CURRENT_TIMESTAMP
    `;

    await this.db.query(sql, [rows]);
  }

  async saveBandwidthSnapshots(rows) {
    if (!rows || rows.length === 0) {
      return;
    }

    const sql = `
      INSERT INTO bandwidth_quality_snapshots
        (proxy_port, ip_address, window_start, window_end, sample_count, avg_bandwidth_mbps, max_bandwidth_mbps, quality)
      VALUES ?
      ON DUPLICATE KEY UPDATE
        window_end = VALUES(window_end),
        sample_count = VALUES(sample_count),
        avg_bandwidth_mbps = VALUES(avg_bandwidth_mbps),
        max_bandwidth_mbps = VALUES(max_bandwidth_mbps),
        quality = VALUES(quality),
        created_at = CURRENT_TIMESTAMP
    `;

    await this.db.query(sql, [rows]);
  }

  classifyTtl(successRate, avgRtt, timeoutRate, sampleCount, isBlocked = false) {
    if (sampleCount === 0) {
      return 'warning';
    }

    if (isBlocked) {
      return 'bad';
    }

    const { warningSuccessRate, badSuccessRate, warningAvgRttMs, badAvgRttMs, warningTimeoutRate, badTimeoutRate } = this.config.thresholds.ttl;

    if (successRate <= badSuccessRate || timeoutRate >= badTimeoutRate || (avgRtt !== null && avgRtt >= badAvgRttMs)) {
      return 'bad';
    }

    if (
      successRate <= warningSuccessRate ||
      timeoutRate >= warningTimeoutRate ||
      (avgRtt !== null && avgRtt >= warningAvgRttMs)
    ) {
      return 'warning';
    }

    return 'good';
  }

  classifyBandwidth(avgBandwidth, sampleCount) {
    if (sampleCount < this.config.thresholds.bandwidth.minSamples || avgBandwidth === null) {
      return 'warning';
    }

    const { warningAvgMbps, badAvgMbps } = this.config.thresholds.bandwidth;

    if (avgBandwidth <= badAvgMbps) {
      return 'bad';
    }

    if (avgBandwidth <= warningAvgMbps) {
      return 'warning';
    }

    return 'good';
  }

  isBadTtlNode({ successRate, avgRtt, maxRtt, failureRate, sampleCount, isBlocked, bandwidthInfo }) {
    if (isBlocked) {
      return false;
    }

    const rttValue = maxRtt ?? avgRtt;
    if (rttValue === null) {
      return false;
    }

    const { highRttMs, highTimeoutRate, blockedSampleMinimum, minTrafficForBadMbps } =
      this.config.thresholds.ttl;

    const avgBandwidth = bandwidthInfo && bandwidthInfo.avgBandwidth !== null
      ? Number(bandwidthInfo.avgBandwidth)
      : null;
    const hasSufficientTraffic = avgBandwidth !== null && avgBandwidth >= minTrafficForBadMbps;
    const hasEnoughSamples = sampleCount >= blockedSampleMinimum;

    if (!hasSufficientTraffic || !hasEnoughSamples) {
      return false;
    }

    const highRtt = rttValue >= highRttMs;
    const failureHigh = (failureRate ?? 0) >= highTimeoutRate;

    return highRtt || failureHigh;
  }

  calculateStats({ windowStart, windowEnd, ttl, bandwidth }) {
    const ttlFailureRate =
      ttl.totalSamples > 0 ? (ttl.totalSamples - ttl.totalSuccess) / ttl.totalSamples : 0;

    return {
      windowStart,
      windowEnd,
      ttl: {
        totalTargets: ttl.totalTargets,
        totalSamples: ttl.totalSamples,
        totalSuccess: ttl.totalSuccess,
        totalTimeouts: ttl.totalTimeouts,
        failureRate: ttlFailureRate,
        badRate:
          ttl.totalTargets > 0
            ? (ttl.badNodes.length + ttl.blockedNodes.length) / ttl.totalTargets
            : 0,
        badNodes: ttl.badNodes,
        blockedNodes: ttl.blockedNodes,
      },
      bandwidth: {
        totalIps: bandwidth.totalIps,
        totalTrafficMbps: bandwidth.totalTrafficMbps,
        badNodes: bandwidth.badNodes,
      },
    };
  }

  async analyzeDailyQuality({ date = null, proxyPort = null } = {}) {
    const baseDate = (() => {
      if (!date) {
        return new Date();
      }
      if (date instanceof Date && !Number.isNaN(date.getTime())) {
        return new Date(date);
      }
      if (typeof date === 'string') {
        const normalized = `${date.trim()}T00:00:00`;
        const parsed = new Date(normalized);
        if (!Number.isNaN(parsed.getTime())) {
          return parsed;
        }
      }
      return new Date();
    })();

    const endOfDay = new Date(baseDate);
    endOfDay.setHours(0, 0, 0, 0);

    const startOfDay = new Date(endOfDay);
    if (!date) {
      startOfDay.setDate(startOfDay.getDate() - 1);
    }

    const windowStartStr = formatDateUtc(startOfDay);
    const windowEndReference = new Date(endOfDay);
    if (date) {
      windowEndReference.setDate(windowEndReference.getDate() + 1);
    }
    const windowEndStr = formatDateUtc(windowEndReference);
    const effectiveWindowEnd = windowEndReference;

    let whereClause = 'WHERE window_start >= ? AND window_start < ?';
    const params = [windowStartStr, windowEndStr];

    if (proxyPort !== null && proxyPort !== undefined) {
      const portNum = Number(proxyPort);
      if (!Number.isFinite(portNum)) {
        throw new Error('Invalid proxyPort');
      }
      whereClause += ' AND proxy_port = ?';
      params.push(portNum);
    }

    const query = `
      SELECT 
        t.proxy_port,
        t.target_host,
        t.target_port,
        SUM(t.sample_count) AS total_samples,
        SUM(t.success_count) AS total_success,
        SUM(t.timeout_count) AS total_failures,
        COUNT(*) AS window_count,
        SUM(CASE WHEN t.quality = 'bad' THEN 1 ELSE 0 END) AS bad_windows,
        SUM(CASE WHEN t.success_count = 0 AND t.timeout_count > 0 THEN 1 ELSE 0 END) AS blocked_windows,
        SUM(CASE WHEN t.success_count = 0 AND t.timeout_count > 0 THEN t.sample_count ELSE 0 END) AS blocked_samples,
        SUM(CASE WHEN t.success_count > 0 THEN t.avg_rtt_ms * t.success_count ELSE 0 END) AS weighted_rtt_sum,
        SUM(CASE WHEN t.success_count > 0 AND b.avg_bandwidth_mbps IS NOT NULL THEN b.avg_bandwidth_mbps * t.success_count ELSE 0 END) AS weighted_bw_sum,
        SUM(CASE WHEN t.success_count > 0 AND b.avg_bandwidth_mbps IS NOT NULL THEN t.success_count ELSE 0 END) AS weighted_bw_samples
      FROM ttl_quality_snapshots t
      LEFT JOIN (
        SELECT 
          proxy_port,
          ip_address,
          AVG(avg_bandwidth_mbps) AS avg_bandwidth_mbps
        FROM bandwidth_quality_snapshots
        WHERE window_start >= ? AND window_start < ?
        GROUP BY proxy_port, ip_address
      ) b
        ON t.proxy_port = b.proxy_port
        AND t.target_host = b.ip_address
      ${whereClause}
      GROUP BY t.proxy_port, t.target_host, t.target_port
    `;

    const queryParams = [windowStartStr, windowEndStr, ...params];
    const [rows] = await this.db.execute(query, queryParams);

    if (!rows || rows.length === 0) {
      return {
        windowStart: startOfDay.toISOString(),
        windowEnd: effectiveWindowEnd.toISOString(),
        ports: [],
      };
    }

    const companyMap = await this.fetchCompanyMap(rows.map((row) => row.target_host));
    const summaryByPort = new Map();

    rows.forEach((row) => {
      const port = Number(row.proxy_port);
      const targetHost = row.target_host;
      const targetPort = Number(row.target_port);
      const totalSamples = Number(row.total_samples) || 0;
      const totalSuccess = Number(row.total_success) || 0;
      const totalFailures = Number(row.total_failures) || 0;
      const windowCount = Number(row.window_count) || 0;
      const badWindows = Number(row.bad_windows) || 0;
      const failureRate = totalSamples > 0 ? totalFailures / totalSamples : 0;
      const successRate = totalSamples > 0 ? totalSuccess / totalSamples : 0;
      const avgRttMs =
        totalSuccess > 0 && Number.isFinite(Number(row.weighted_rtt_sum))
          ? Number(row.weighted_rtt_sum) / totalSuccess
          : null;
      const avgTrafficMbps =
        Number(row.weighted_bw_samples) > 0 && Number.isFinite(Number(row.weighted_bw_sum))
          ? Number(row.weighted_bw_sum) / Number(row.weighted_bw_samples)
          : null;
      const dataCenter = resolveDataCenterName(companyMap.get(targetHost) || null);

      const portEntry = summaryByPort.get(port) || {
        proxyPort: port,
        totalNodes: 0,
        totalWindows: 0,
        nodes: [],
        blockedNodes: [],
        totalBlockedWindows: 0,
        totalBlockedMinutes: 0,
        portInfo: this.getPortMetadata(port),
        portLabel: this.formatPortShort(port),
      };

      portEntry.totalNodes += 1;
      portEntry.totalWindows += windowCount;
      portEntry.nodes.push({
        targetHost,
        targetPort,
        dataCenter,
        badWindows,
        windowCount,
        avgRttMs,
        avgTrafficMbps,
        failureRate,
        successRate,
        portLabel: this.formatPortShort(port),
      });

      const blockedWindows = Number(row.blocked_windows) || 0;
      const blockedSamples = Number(row.blocked_samples) || 0;
      if (blockedWindows > 0) {
        const blockedMinutes = blockedWindows * this.config.windowMinutes;
        portEntry.totalBlockedWindows += blockedWindows;
        portEntry.totalBlockedMinutes += blockedMinutes;
        portEntry.blockedNodes.push({
          targetHost: targetHost.includes(':80') ? targetHost.replace(':80', '') : targetHost,
          targetPort,
          dataCenter,
          blockedWindows,
          blockedMinutes,
          blockedSamples,
          portLabel: this.formatPortShort(port),
        });
      }

      summaryByPort.set(port, portEntry);
    });

    const ports = Array.from(summaryByPort.values()).map((portEntry) => {
      const topBadNodes = portEntry.nodes
        .filter((node) => node.badWindows > 0 || node.failureRate > 0)
        .sort((a, b) => {
          if (b.badWindows !== a.badWindows) {
            return b.badWindows - a.badWindows;
          }
          if (b.failureRate !== a.failureRate) {
            return b.failureRate - a.failureRate;
          }
          return (b.avgRttMs || 0) - (a.avgRttMs || 0);
        })
        .slice(0, 6)
        .map((node) => ({
          targetHost: node.targetHost.includes(':80')
            ? node.targetHost.replace(':80', '')
            : node.targetHost,
          targetPort: node.targetPort,
          dataCenter: node.dataCenter,
          badWindows: node.badWindows,
          windowCount: node.windowCount,
          avgRttMs: node.avgRttMs,
          avgTrafficMbps: node.avgTrafficMbps,
          failureRate: node.failureRate,
          successRate: node.successRate,
          portLabel: node.portLabel,
        }));

      const blockedNodes = portEntry.blockedNodes
        .slice()
        .sort((a, b) => b.blockedMinutes - a.blockedMinutes)
        .map((node) => ({
          targetHost: node.targetHost,
          targetPort: node.targetPort,
          dataCenter: node.dataCenter,
          blockedWindows: node.blockedWindows,
          blockedMinutes: node.blockedMinutes,
          blockedSamples: node.blockedSamples,
          portLabel: node.portLabel,
        }));

      return {
        proxyPort: portEntry.proxyPort,
        portInfo: portEntry.portInfo,
        portLabel: portEntry.portLabel || this.formatPortShort(portEntry.proxyPort),
        totalNodes: portEntry.totalNodes,
        totalWindows: portEntry.totalWindows,
        totalBlockedWindows: portEntry.totalBlockedWindows,
        totalBlockedMinutes: portEntry.totalBlockedMinutes,
        topBadNodes,
        blockedNodes,
      };
    });

    ports.sort((a, b) => a.proxyPort - b.proxyPort);

    const blockedNodesSummary = ports.flatMap((port) =>
      port.blockedNodes.map((node) => ({
        ...node,
        proxyPort: port.proxyPort,
        portLabel: port.portLabel,
        portInfo: port.portInfo,
      }))
    );

    return {
      windowStart: startOfDay.toISOString(),
      windowEnd: effectiveWindowEnd.toISOString(),
      ports,
      blockedNodes: blockedNodesSummary,
    };
  }

  async sendDailyAnalysisReport({ date = null, proxyPort = null, recipients = [] } = {}) {
    if (!this.telegramService || !this.telegramService.isEnabled()) {
      throw new Error('Telegram service is not enabled');
    }

    const analysis = await this.analyzeDailyQuality({ date, proxyPort });
    const message = this.buildDailyAnalysisMessage(analysis);
    if (!message) {
      return { ok: false, reason: 'empty_message', analysis };
    }

    const deliveryResults = [];
    if (Array.isArray(recipients) && recipients.length > 0) {
      for (const recipient of recipients) {
        if (!recipient || (!recipient.chatId && !recipient.username)) {
          continue;
        }
        const chatTarget = recipient.chatId || recipient.username;
        const sent = await this.telegramService.sendToChat(chatTarget, message, {
          contactId: recipient.contactId || null,
          chatTitle: recipient.name || null,
        });
        deliveryResults.push({
          contactId: recipient.contactId || null,
          chatId: chatTarget,
          sent: Boolean(sent && sent.ok),
          error: sent && !sent.ok ? sent.error : null,
        });
      }
    } else {
      const sent = await this.telegramService.sendMessage(message);
      deliveryResults.push({
        contactId: null,
        chatId: null,
        sent: Boolean(sent && sent.ok),
        error: sent && !sent.ok ? sent.error : null,
      });
    }

    return {
      ok: deliveryResults.some((entry) => entry.sent),
      analysis,
      deliveries: deliveryResults,
    };
  }

  updateEmergencyState(stats, reason) {
    this.currentMeasurementIntervalMs = this.config.normalMeasurementIntervalMs;
    this.currentEmergencyState = {
      active: false,
      reasons: [],
      since: null,
      updatedAt: new Date(),
    };

    this.emergencyListeners.forEach((listener) => {
      try {
        listener(this.currentEmergencyState, stats, reason);
      } catch (error) {
        console.error('❌ Emergency listener error:', error.message);
      }
    });
  }
}

module.exports = QualityService;

