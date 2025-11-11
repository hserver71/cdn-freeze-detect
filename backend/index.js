const express = require('express');
const cors = require('cors');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { createDbConnection, initializeDatabase } = require('./config/database');
const DatabaseService = require('./services/databaseService');
const ProxyService = require('./services/proxyService');
const MeasurementController = require('./controllers/measurementController');
const SystemController = require('./controllers/systemController');
const apiRoutes = require('./routes');
const BandwidthService = require('./services/bandwidthService');
const BandwidthController = require('./controllers/bandwidthController');
const CdnService = require('./services/cdnService');
const CdnController = require('./controllers/cdnController');
const cdnRoutes = require('./routes/cdn');
const QualityService = require('./services/qualityService');
const TelegramService = require('./services/telegramService');
const QualityController = require('./controllers/qualityController');
const AccountService = require('./services/accountService');
const ChatLogService = require('./services/chatLogService');
const AccountController = require('./controllers/accountController');
const accountRoutes = require('./routes/accounts');
const SettingsService = require('./services/settingsService');
const SettingsController = require('./controllers/settingsController');
const settingsRoutes = require('./routes/settings');


const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({
  server,
  path: '/ws'
});

const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors({
  origin: '*',
  optionsSuccessStatus: 200,
}));
app.use(express.json());

// WebSocket connections storage
const clients = new Set();

// WebSocket connection handler
wss.on('connection', (ws, req) => {
  console.log('🔌 New WebSocket connection from:', req.headers.origin);
  clients.add(ws);

  ws.send(JSON.stringify({
    type: 'connection_established',
    message: 'Connected to measurement server',
    timestamp: new Date().toISOString()
  }));

  ws.on('close', () => {
    console.log('🔌 WebSocket connection closed');
    clients.delete(ws);
  });

  ws.on('error', (error) => {
    console.error('❌ WebSocket error:', error);
    clients.delete(ws);
  });

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);

      if (data.type === 'ping') {
        ws.send(JSON.stringify({
          type: 'pong',
          timestamp: new Date().toISOString()
        }));
      }
    } catch (error) {
      console.error('❌ Error parsing WebSocket message:', error);
    }
  });
});

// Broadcast to all connected clients
const broadcastToClients = (data) => {
  const message = JSON.stringify(data);
  let sentCount = 0;

  clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
      sentCount++;
    }
  });

  console.log(`📤 Broadcast to ${sentCount}/${clients.size} clients`);
};

// Enhanced IP information service initialization with MySQL memory table
async function initializeIPDatabase() {
  try {
    console.log('🔄 Initializing IP information service with MySQL memory table...');
    const startTime = Date.now();

    const IPInfoService = require('./services/ipInfoService');

    // Make sure IPInfoService has the database connection
    if (!IPInfoService.isInitialized && db) {
      IPInfoService.setDatabase(db);
    }

    if (!IPInfoService.isInitialized) {
      console.log('⚠️ IPInfoService not initialized yet, waiting for database...');
      return 0;
    }

    const loadedCount = await IPInfoService.loadIPRangesFromCSV('./data/asn.csv');

    const loadTime = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`✅ IP information service ready in ${loadTime}s with ${loadedCount} ranges`);

    return loadedCount;
  } catch (error) {
    console.error('❌ Failed to initialize IP information service:', error);
    return 0;
  }
}

// Global state
let db;
let databaseService;
let proxyService;
let measurementController;
let systemController;
let cleanupInterval;
let qualityService;
let telegramService;
let accountService;
let chatLogService;
let isMeasuring = false;
let measurementTimer = null;
const NORMAL_MEASUREMENT_INTERVAL_MS = 15 * 60 * 1000;
const EMERGENCY_MEASUREMENT_INTERVAL_MS = 5 * 60 * 1000;
let currentMeasurementIntervalMs = NORMAL_MEASUREMENT_INTERVAL_MS;

const formatIntervalMinutes = (ms) => (ms / 60000).toFixed(1);

function stopScheduledMeasurements() {
  if (measurementTimer) {
    clearTimeout(measurementTimer);
    measurementTimer = null;
    console.log('🛑 Stopped automatic measurements');
  }
}

function scheduleNextMeasurement(delayMs) {
  const wait = typeof delayMs === 'number' && !Number.isNaN(delayMs)
    ? Math.max(delayMs, 30 * 1000)
    : currentMeasurementIntervalMs;

  if (measurementTimer) {
    clearTimeout(measurementTimer);
    measurementTimer = null;
  }

  measurementTimer = setTimeout(async () => {
    measurementTimer = null;
    await runScheduledMeasurements();
  }, wait);

  console.log(`⏰ Next automatic measurement scheduled in ${formatIntervalMinutes(wait)} minutes`);
}

function applyEmergencyMode(state) {
  const desiredInterval = qualityService
    ? qualityService.getCurrentMeasurementIntervalMs()
    : (state && state.active ? EMERGENCY_MEASUREMENT_INTERVAL_MS : NORMAL_MEASUREMENT_INTERVAL_MS);

  if (desiredInterval !== currentMeasurementIntervalMs) {
    currentMeasurementIntervalMs = desiredInterval;
    console.log(
      `⏱️ Measurement cadence set to ${formatIntervalMinutes(currentMeasurementIntervalMs)} minutes (${state && state.active ? 'EMERGENCY' : 'NORMAL'})`
    );

    // reschedule upcoming measurement according to the new cadence
    scheduleNextMeasurement(currentMeasurementIntervalMs);
  }
}

// Function to refresh IP list
const refreshIpList = async () => {
  try {
    console.log('🔄 Refreshing IP list...');
    await proxyService.refreshTargets();
    const currentTargets = proxyService.getTargets();

    console.log(`✅ IP list refreshed. Current targets: ${currentTargets.length}`);
    broadcastToClients({
      type: 'ip_list_updated',
      message: `IP list updated with ${currentTargets.length} targets`,
      targetCount: currentTargets.length,
      timestamp: new Date().toISOString()
    });

    return currentTargets;
  } catch (error) {
    console.error('❌ Error refreshing IP list:', error.message);
    throw error;
  }
};

// Manual measurement function
const runManualMeasurements = async () => {
  if (isMeasuring) {
    console.log('⏳ Measurement already in progress, skipping manual request...');
    broadcastToClients({
      type: 'measurement_status',
      status: 'already_running',
      message: 'Measurement already in progress',
      timestamp: new Date().toISOString()
    });
    return;
  }

  isMeasuring = true;

  try {
    console.log('🚀 Starting manual measurements...');
    broadcastToClients({
      type: 'measurement_status',
      status: 'started',
      message: 'Manual measurement started',
      timestamp: new Date().toISOString()
    });

    await refreshIpList();
    await proxyService.runMeasurements(databaseService, 'http', { refreshTargets: false });

    broadcastToClients({
      type: 'measurement_status',
      status: 'completed',
      message: 'Manual measurement completed',
      timestamp: new Date().toISOString()
    });

    broadcastToClients({
      type: 'data_updated',
      message: 'New measurement data available',
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ Error during manual measurements:', error.message);
    broadcastToClients({
      type: 'measurement_status',
      status: 'error',
      message: 'Measurement failed',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  } finally {
    isMeasuring = false;
    scheduleNextMeasurement(currentMeasurementIntervalMs);
  }
};

// Scheduled measurement function
async function runScheduledMeasurements() {
  if (isMeasuring) {
    console.log('⏳ Measurement already in progress, skipping scheduled run...');
    scheduleNextMeasurement(currentMeasurementIntervalMs);
    return;
  }

  isMeasuring = true;

  try {
    console.log('🔄 Starting scheduled measurements...');
    broadcastToClients({
      type: 'measurement_status',
      status: 'scheduled_started',
      message: 'Scheduled measurement started',
      timestamp: new Date().toISOString()
    });

    await refreshIpList();
    await proxyService.runMeasurements(databaseService, 'http', { refreshTargets: false });

    broadcastToClients({
      type: 'measurement_status',
      status: 'scheduled_completed',
      message: 'Scheduled measurement completed',
      timestamp: new Date().toISOString()
    });

    broadcastToClients({
      type: 'data_updated',
      message: 'New measurement data available from scheduled run',
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ Error during scheduled measurements:', error.message);
    broadcastToClients({
      type: 'measurement_status',
      status: 'error',
      message: 'Scheduled measurement failed',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  } finally {
    isMeasuring = false;
    scheduleNextMeasurement();
  }
}


// Manual IP list refresh endpoint
app.post('/api/measurements/refresh-ips', async (req, res) => {
  try {
    console.log('🔄 Manual IP list refresh requested');
    const targets = await refreshIpList();

    res.json({
      success: true,
      message: `IP list refreshed with ${targets.length} targets`,
      targetCount: targets.length,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('❌ Error refreshing IP list:', error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to refresh IP list'
    });
  }
});

// WebSocket info endpoint
app.get('/api/websocket/info', (req, res) => {
  res.json({
    connectedClients: clients.size,
    isWebSocketServer: true,
    serverTime: new Date().toISOString()
  });
});

// IP Information endpoints - Updated to use MySQL
app.get('/api/ip-info/:ip', async (req, res) => {
  try {
    const { ip } = req.params;
    const IPInfoService = require('./services/ipInfoService');

    // Check if initialized
    if (!IPInfoService.isInitialized) {
      return res.status(503).json({
        success: false,
        error: 'IP information service not initialized'
      });
    }

    const info = await IPInfoService.getIPInfo(ip);

    res.json({
      success: true,
      ipInfo: info
    });
  } catch (error) {
    console.error('❌ Error in IP info route:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get IP information'
    });
  }
});

// Get IP information for multiple IPs
app.post('/api/ip-info/batch', async (req, res) => {
  try {
    const { ipList } = req.body;

    if (!ipList || !Array.isArray(ipList)) {
      return res.status(400).json({
        success: false,
        error: 'IP list is required'
      });
    }

    const IPInfoService = require('./services/ipInfoService');

    // Check if initialized
    if (!IPInfoService.isInitialized) {
      return res.status(503).json({
        success: false,
        error: 'IP information service not initialized'
      });
    }

    const ipInfo = await IPInfoService.getIPInfoBatch(ipList);

    res.json({
      success: true,
      ipInfo: ipInfo
    });
  } catch (error) {
    console.error('❌ Error in batch IP info route:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get batch IP information'
    });
  }
});

const initializeApp = async () => {
  try {
    // Initialize database
    db = createDbConnection();
    await initializeDatabase(db);

    // Initialize IPInfoService FIRST
    const IPInfoService = require('./services/ipInfoService');
    IPInfoService.setDatabase(db);
    console.log('✅ IPInfoService initialized with database connection');

    // Initialize services
    databaseService = new DatabaseService(db);
    proxyService = new ProxyService();
    accountService = new AccountService(db);
    chatLogService = new ChatLogService(db);
    const settingsService = new SettingsService(db);

    const personalAccount = await accountService.ensureAccount({
      name: process.env.PERSONAL_ACCOUNT_NAME || 'Personal Account',
      type: 'personal',
      accountKey: process.env.PERSONAL_ACCOUNT_KEY || 'personal-account',
    });

    const botAccount = await accountService.ensureAccount({
      name: process.env.BOT_ACCOUNT_NAME || 'Bot Account',
      type: 'bot',
      accountKey: process.env.BOT_ACCOUNT_KEY || 'bot-account',
    });

    telegramService = new TelegramService({
      chatLogService,
      botAccountId: botAccount ? botAccount.id : null,
    });

    qualityService = new QualityService(db, proxyService, telegramService);
    qualityService.onEmergencyChange((state) => {
      applyEmergencyMode(state);
    });

    const bandwidthService = new BandwidthService(proxyService, databaseService);
    const bandwidthController = new BandwidthController(bandwidthService);
    const cdnService = new CdnService(db);
    const cdnController = new CdnController(cdnService);
    // Initialize Cache Service and start scheduler
    const CacheService = require('./services/cacheService');
    const cacheService = new CacheService(databaseService);


    const startBandwidthCollection = () => {
      const BANDWIDTH_INTERVAL = 60 * 1000; // 1 minute
      console.log(`📊 Starting bandwidth collection every ${BANDWIDTH_INTERVAL / 1000} seconds`);

      // Run immediately on startup
      bandwidthService.collectBandwidthData();

      // Schedule recurring collection
      const bandwidthInterval = setInterval(() => {
        bandwidthService.collectBandwidthData();
      }, BANDWIDTH_INTERVAL);

      return bandwidthInterval;
    };

    let bandwidthInterval;
    // Add in initializeApp function after server.listen:
    bandwidthInterval = startBandwidthCollection();

    // Start cleanup scheduler for old data
    const startCleanupScheduler = () => {
      const CLEANUP_INTERVAL = 6 * 60 * 60 * 1000; // 6 hours
      const MEASUREMENTS_RETENTION_DAYS = 2;
      const SERVER_METRICS_RETENTION_DAYS = 7;

      console.log(`🧹 Starting cleanup scheduler (runs every ${CLEANUP_INTERVAL / (60 * 60 * 1000)} hours)`);
      console.log(`   - measurements: ${MEASUREMENTS_RETENTION_DAYS} days retention`);
      console.log(`   - server_metrics: ${SERVER_METRICS_RETENTION_DAYS} days retention`);

      // Helper function to run cleanup tasks
      const runCleanups = async () => {
        const [measurementsResult, serverMetricsResult] = await Promise.all([
          databaseService.cleanupOldMeasurements(MEASUREMENTS_RETENTION_DAYS),
          databaseService.cleanupOldServerMetrics(SERVER_METRICS_RETENTION_DAYS)
        ]);

        if (measurementsResult.success && measurementsResult.deletedCount > 0) {
          console.log(`✅ Cleaned ${measurementsResult.deletedCount} old measurements`);
        }
        if (serverMetricsResult.success && serverMetricsResult.deletedCount > 0) {
          console.log(`✅ Cleaned ${serverMetricsResult.deletedCount} old server_metrics`);
        }
      };

      // Run cleanup immediately on startup
      runCleanups().catch(error => {
        console.error('❌ Initial cleanup failed:', error.message);
      });

      // Schedule recurring cleanup
      const cleanupInterval = setInterval(() => {
        runCleanups().catch(error => {
          console.error('❌ Scheduled cleanup failed:', error.message);
        });
      }, CLEANUP_INTERVAL);

      return cleanupInterval;
    };

    cleanupInterval = startCleanupScheduler();

    // Initialize MEMORY cache
    await databaseService.initializeMemoryCache();

    // Initialize controllers
    measurementController = new MeasurementController(databaseService, proxyService);
    systemController = new SystemController(databaseService);

    // Initialize history controller
    const HistoryController = require('./controllers/historyController');
    const historyController = new HistoryController(databaseService, proxyService);

    const ErrorLogService = require('./services/errorLogService');
    const ErrorLogController = require('./controllers/errorLogController');
    const errorLogService = new ErrorLogService(proxyService);
    const errorLogController = new ErrorLogController(errorLogService);

    // Initialize metrics controller
    const MetricsController = require('./controllers/metricsController');
    const PortService = require('./services/portService');
    const PortController = require('./controllers/portController');
    const metricsController = new MetricsController(db);
    const ContactService = require('./services/contactService');
    const ContactController = require('./controllers/contactController');
    const portService = new PortService(databaseService);
    const ports = await portService.listPorts();
    proxyService.setPortMetadata(ports);
    qualityService.setPortMetadata(ports);

    const refreshPortMetadata = async () => {
      const latestPorts = await portService.listPorts();
      proxyService.setPortMetadata(latestPorts);
      qualityService.setPortMetadata(latestPorts);
      return latestPorts;
    };

    const portController = new PortController(portService, refreshPortMetadata);
    const contactService = new ContactService(db);
    const contactController = new ContactController(contactService, accountService);
    const accountController = new AccountController(accountService, contactService, chatLogService, telegramService);
    const settingsController = new SettingsController(settingsService);
    const qualityController = new QualityController(
      qualityService,
      db,
      telegramService,
      contactService,
      accountService,
      chatLogService,
      settingsService
    );

    const ensureBossContactsOnBot = async () => {
      if (!contactService || !personalAccount || !botAccount) {
        return;
      }

      try {
        const personalContacts = await contactService.listContacts({
          accountId: personalAccount.id,
        });
        const bossContacts = personalContacts.filter(
          (contact) => (contact.role || '').toLowerCase() === 'boss'
        );

        for (const contact of bossContacts) {
          const existing = await contactService.findContactByAccountAndTelegram({
            accountId: botAccount.id,
            telegramChatId: contact.telegramChatId || null,
            telegramUsername: contact.telegramUsername || null,
          });

          if (existing) {
            continue;
          }

          await contactService.createContact({
            accountId: botAccount.id,
            name: contact.name,
            telegramUsername: contact.telegramUsername,
            telegramChatId: contact.telegramChatId,
            firstName: contact.firstName,
            lastName: contact.lastName,
            telegramPhone: contact.telegramPhone,
            role: contact.role,
            isImportant: true,
            notifyOnExternal: true,
            notes: contact.notes,
          });
        }
      } catch (error) {
        console.error('⚠️ Failed to sync boss contacts to bot account:', error.message);
      }
    };

    await ensureBossContactsOnBot();
    
    // Update routes setup:
    app.use('/api/cdn', cdnRoutes(cdnController));
    app.use('/api/accounts', accountRoutes(accountController));
    app.use('/api/settings', settingsRoutes(settingsController));
    app.use('/api', apiRoutes(
      measurementController,
      systemController,
      historyController,
      bandwidthController,
      errorLogController,
      metricsController,
      qualityController,
      contactController,
      portController
    ));

    qualityService.start();
    if (telegramService.isEnabled()) {
      console.log('📣 Telegram notifications enabled');
    } else {
      console.log('ℹ️ Telegram notifications disabled (missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID)');
    }
    // Get companies from historical IPs in measurements table
    app.get('/api/companies/historical', async (req, res) => {
      try {
        const { proxyPort = '10220', period = '24h' } = req.query;
        const proxyPortNum = parseInt(proxyPort, 10);

        // Calculate time range based on period
        const endTime = new Date();
        let startTime = new Date();

        switch (period) {
          case '6h': startTime.setTime(endTime.getTime() - (6 * 60 * 60 * 1000)); break;
          case '24h': startTime.setTime(endTime.getTime() - (24 * 60 * 60 * 1000)); break;
          case '7d': startTime.setTime(endTime.getTime() - (7 * 24 * 60 * 60 * 1000)); break;
          case '30d': startTime.setTime(endTime.getTime() - (30 * 24 * 60 * 60 * 1000)); break;
          default: startTime.setTime(endTime.getTime() - (24 * 60 * 60 * 1000));
        }

        // Get distinct IPs from measurements in this period
        const query = `
          SELECT DISTINCT target_host 
          FROM measurements 
          WHERE proxy_port = ? 
          AND created_at BETWEEN ? AND ?
          ORDER BY target_host
          LIMIT 1000
      `;

        const [ipRows] = await db.execute(query, [proxyPortNum, startTime, endTime]);
        const ipList = ipRows.map(row => row.target_host);

        if (ipList.length === 0) {
          return res.json({ success: true, companies: [] });
        }

        // Get company info using binary search
        const IPInfoService = require('./services/ipInfoService');

        // Check if initialized
        if (!IPInfoService.isInitialized) {
          return res.status(503).json({
            success: false,
            error: 'IP information service not initialized'
          });
        }

        const companiesData = await IPInfoService.getCompaniesForIPs(ipList);

        // Extract unique company names
        const uniqueCompanies = [...new Set(
          Object.values(companiesData)
            .filter(info => info.found && info.company && info.company !== 'Unknown')
            .map(info => info.company)
        )].sort();

        console.log(`🏢 Found ${uniqueCompanies.length} companies from ${ipList.length} historical IPs`);

        res.json({
          success: true,
          companies: uniqueCompanies,
          totalIPs: ipList.length
        });

      } catch (error) {
        console.error('❌ Error in companies/historical:', error);
        res.status(500).json({
          success: false,
          error: 'Failed to fetch historical companies'
        });
      }
    });

    // Manual measurement endpoint
    app.post('/api/measurements/send-packet', async (req, res) => {
      try {
        console.log('📦 Manual packet send requested');
        broadcastToClients({
          type: 'measurement_status',
          status: 'manual_requested',
          message: 'Manual packet send requested',
          timestamp: new Date().toISOString()
        });

        runManualMeasurements();

        res.json({
          success: true,
          message: 'Packet send initiated',
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        console.error('❌ Error initiating manual measurement:', error.message);
        res.status(500).json({
          success: false,
          error: 'Failed to initiate measurement'
        });
      }
    });

    // Initialize IP database and start server
    initializeIPDatabase().then((loadedCount) => {
      // Start cache scheduler AFTER IP ranges are loaded
      cacheService.startScheduler();

      server.listen(PORT, () => {
        console.log(`🚀 Server is running at port ${PORT}!`);
        console.log(`🔌 WebSocket server running on ws://162.247.153.49:${PORT}/ws`);
        console.log(`⏰ Automatic measurements: ENABLED`);
        console.log(`📦 Manual packet endpoint: POST /api/measurements/send-packet`);
        console.log(`🔄 IP refresh endpoint: POST /api/measurements/refresh-ips`);
        console.log(`🌐 IP info endpoints: GET /api/ip-info/:ip, POST /api/ip-info/batch`);
        console.log(`📊 IP ranges loaded: ${loadedCount} entries`);
        console.log(`💾 Cache scheduler: STARTED`);
        console.log(`🧹 Cleanup scheduler: STARTED (measurements: 2 days, server_metrics: 7 days)`);

        scheduleNextMeasurement(60 * 1000);
      });
    });

  } catch (error) {
    console.error('❌ Failed to initialize application:', error.message);
    process.exit(1);
  }
};

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down gracefully...');
  stopScheduledMeasurements();

  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
    console.log('🧹 Cleanup scheduler stopped');
  }

  if (qualityService) {
    qualityService.stop();
  }

  clients.forEach(client => {
    client.close();
  });

  if (db) {
    db.end();
  }
  process.exit(0);
});

// Start the application
initializeApp();