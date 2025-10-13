const express = require('express');
const cors = require('cors');
const WebSocket = require('ws');
const http = require('http');
require('dotenv').config();

const { createDbConnection, initializeDatabase } = require('./config/database');
const DatabaseService = require('./services/databaseService');
const ProxyService = require('./services/proxyService');
const MeasurementController = require('./controllers/measurementController');
const SystemController = require('./controllers/systemController');
const apiRoutes = require('./routes');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({
  server,
  path: '/ws' // Add explicit WebSocket path
});

const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors({
  origin: ['http://162.247.153.49:3000', 'http://localhost:3000', 'http://127.0.0.1:3000'],
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  credentials: true
}));
app.use(express.json());

// WebSocket connections storage
const clients = new Set();

// WebSocket connection handler
wss.on('connection', (ws, req) => {
  console.log('🔌 New WebSocket connection from:', req.headers.origin);
  clients.add(ws);

  // Send initial connection confirmation
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

  // Handle incoming messages from clients
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      console.log('📨 Received WebSocket message:', data);

      // Handle ping/pong for connection health
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

// Global state
let db;
let databaseService;
let proxyService;
let measurementController;
let systemController;
let measurementInterval;
let isMeasuring = false;

// Function to refresh IP list
const refreshIpList = async () => {
  try {
    console.log('🔄 Refreshing IP list...');

    // Call the method to refresh targets in ProxyService
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

// Manual measurement function (UPDATED)
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

    // Refresh IP list before manual measurement
    await refreshIpList();

    // await proxyService.runMeasurements(databaseService, 'tcp_handshake');
    await proxyService.runMeasurements(databaseService, 'http');

    broadcastToClients({
      type: 'measurement_status',
      status: 'completed',
      message: 'Manual measurement completed',
      timestamp: new Date().toISOString()
    });

    // Notify clients to refresh data
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
  }
};

// Scheduled measurement function (UPDATED)
const runScheduledMeasurements = async () => {
  if (isMeasuring) {
    console.log('⏳ Measurement already in progress, skipping scheduled run...');
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

    // Refresh IP list before scheduled measurement
    await refreshIpList();

    await proxyService.runMeasurements(databaseService, 'http');
    // await proxyService.runMeasurements(databaseService, 'tcp_handshake');

    broadcastToClients({
      type: 'measurement_status',
      status: 'scheduled_completed',
      message: 'Scheduled measurement completed',
      timestamp: new Date().toISOString()
    });

    // Notify clients to refresh data
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
  }
};

const startScheduledMeasurements = () => {
  const MEASUREMENT_INTERVAL = 3 * 60 * 1000; // 3 minutes

  console.log(`⏰ Starting automatic measurements every ${MEASUREMENT_INTERVAL / 60000} minutes`);

  // Run immediately on startup
  runScheduledMeasurements();

  // Then run every 3 minutes
  measurementInterval = setInterval(() => {
    runScheduledMeasurements();
  }, MEASUREMENT_INTERVAL);
};

const stopScheduledMeasurements = () => {
  if (measurementInterval) {
    clearInterval(measurementInterval);
    measurementInterval = null;
    console.log('🛑 Stopped automatic measurements');
  }
};

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

const initializeApp = async () => {
  try {
    // Initialize database
    db = createDbConnection();
    await initializeDatabase(db);

    // Initialize services
    databaseService = new DatabaseService(db);
    proxyService = new ProxyService();

    // Initialize controllers
    measurementController = new MeasurementController(databaseService);
    systemController = new SystemController(databaseService);

    // Add near other controller imports
    const HistoryController = require('./controllers/historyController');

    // In initializeApp function, add:
    const historyController = new HistoryController(databaseService);

    // Update routes setup:
    app.use('/api', apiRoutes(measurementController, systemController, historyController));

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

        // Run measurements in background (don't wait for completion)
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

    // Control endpoints
    app.get('/measurements/start', (req, res) => {
      startScheduledMeasurements();
      res.json({ message: 'Scheduled measurements started' });
    });

    app.get('/measurements/stop', (req, res) => {
      stopScheduledMeasurements();
      res.json({ message: 'Scheduled measurements stopped' });
    });

    app.get('/measurements/status', (req, res) => {
      res.json({
        isRunning: measurementInterval !== null,
        isMeasuring: isMeasuring,
        interval: 3 * 60 * 1000,
        nextRun: measurementInterval ? 'Active' : 'Stopped',
        connectedClients: clients.size
      });
    });

    // Start server
    server.listen(PORT, () => {
      console.log(`🚀 Server is running at port ${PORT}!`);
      console.log(`🔌 WebSocket server running on ws://162.247.153.49:${PORT}/ws`);
      console.log(`⏰ Automatic measurements: ENABLED`);
      console.log(`📦 Manual packet endpoint: POST /api/measurements/send-packet`);
      console.log(`🔄 IP refresh endpoint: POST /api/measurements/refresh-ips`);

      // Start scheduled measurements
      startScheduledMeasurements();
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

  // Close all WebSocket connections
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