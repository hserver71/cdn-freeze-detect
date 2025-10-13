const express = require('express')
const env = require('dotenv')
const tunnel = require('tunnel')
const { performance } = require('perf_hooks')
const http = require('http')
const { default: axios } = require('axios')
const cors = require('cors');

const app = express()
// Enable CORS for all routes
app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    
    const allowedOrigins = [
      'http://162.247.153.49:3000',
      'http://localhost:3000',
      'http://127.0.0.1:3000'
    ];
    
    if (allowedOrigins.indexOf(origin) !== -1) {
      return callback(null, true);
    } else {
      const msg = 'The CORS policy for this site does not allow access from the specified Origin.';
      return callback(new Error(msg), false);
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  credentials: true
}));

env.config();

// Standard Express setup
app.get('/', (req, res) => {
    res.json({ message: 'Network status server running.' });
})

app.get('/get-nodes', (req, res) => {
    axios.get("https://slave.host-palace.net/portugal_cdn/get_node_list")
        .then(response => {
            res.json(response.data);
        })
        .catch(err => {
            res.status(500).json({ error: err.message });
        });
})

app.get('/now-status', async (req, res) => {
    try {
        const url = "https://slave.host-palace.net/portugal_cdn/get_node_list";
        const response = await axios.get(url);
        const data = response.data;

        const ipList = data
            .filter(item => typeof item === "object" && item.category === 4)
            .map(item => item.ip);

        console.log(`🔄 Processing ${ipList.length} IPs in parallel...`);

        // Process in parallel instead of sequentially
        const results = await Promise.all(
            ipList.map(ip => measureProxiedLatencyAsync(
                ip, 
                80, 
                'proxy.soax.com', 
                10220, 
                process.env.PROXY_USER, 
                process.env.PROXY_PASS, 
                10000
            ))
        );

        console.log(`✅ Completed measurements for ${results.length} targets`);

        res.json({
            status: "completed",
            count: results.length,
            results
        });
    } catch (err) {
        console.error("Error:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// -----------------------------------------------------------
// 🛠️ NETWORK MEASUREMENT FUNCTION (Promise Wrapper)
// -----------------------------------------------------------

/**
 * Measures the network latency (RTT) to a target host via an HTTP proxy.
 * @param {string} targetHost - The final host IP or domain.
 * @param {number} targetPort - The final port (e.g., 80 or 443).
 * @param {string} proxyHost - The proxy server host.
 * @param {number} proxyPort - The proxy server port.
 * @param {string} user - Proxy username.
 * @param {string} pass - Proxy password.
 * @param {number} timeout - Request timeout in milliseconds.
 */
function measureProxiedLatencyAsync(
  targetHost,
  targetPort,
  proxyHost,
  proxyPort,
  user,
  pass,
  timeout
) {
  return new Promise((resolve) => {
    const authString = (user && pass) ? `${user}:${pass}` : '';
    const startTime = performance.now();

    const resultTemplate = {
      target: `${targetHost}:${targetPort}`,
      proxy: `${proxyHost}:${proxyPort}`,
      status: 'pending',
      rtt: null,
      error: null,
      message: null
    };

    console.log(`📡 Measuring full RTT to ${targetHost}:${targetPort} via proxy`);

    try {
      const proxyConfig = {
        host: proxyHost,
        port: proxyPort,
        headers: { 'User-Agent': 'Node.js-Network-Check' }
      };

      if (authString) {
        proxyConfig.proxyAuth = authString;
      }

      const tunnelingAgent = tunnel.httpOverHttp({ proxy: proxyConfig });

      // ✅ We make an actual HEAD request to the *target*, not just CONNECT
      const requestOptions = {
        method: 'HEAD',
        host: targetHost,
        port: targetPort,
        path: '/',              // ✅ Required to reach the target server
        agent: tunnelingAgent,
        timeout
      };

      const req = http.request(requestOptions, (res) => {
        const endTime = performance.now();
        const rtt = (endTime - startTime).toFixed(2);
        resultTemplate.rtt = `${rtt}ms`;

        if (res.statusCode >= 400 && res.statusCode < 500) {
          resultTemplate.status = 'proxy_rejected';
          resultTemplate.error = res.statusCode;
          resultTemplate.message = `Proxy rejected with HTTP ${res.statusCode}`;
        } else {
          resultTemplate.status = 'success';
          resultTemplate.message = `Target host responded through proxy.`;
        }

        res.resume();
        resolve(resultTemplate);
      });

      req.on('error', (err) => {
        const duration = (performance.now() - startTime).toFixed(2);
        resultTemplate.rtt = `${duration}ms`;
        resultTemplate.status = 'failed';
        resultTemplate.error = err.code || 'NetworkError';
        resultTemplate.message = err.message;
        resolve(resultTemplate);
      });

      req.on('timeout', () => {
        const duration = (performance.now() - startTime).toFixed(2);
        req.destroy();
        resultTemplate.rtt = `${duration}ms`;
        resultTemplate.status = 'timeout';
        resultTemplate.error = 'ETIMEOUT';
        resultTemplate.message = `Timed out after ${timeout}ms`;
        resolve(resultTemplate);
      });

      req.end();

    } catch (e) {
      resultTemplate.status = 'error';
      resultTemplate.error = 'ScriptSetupError';
      resultTemplate.message = e.message;
      resolve(resultTemplate);
    }
  });
}

app.listen(process.env.PORT || 5000, () => {
    console.log("Server is running at port 5000! Access /now-status to run the measurement.");
});