const express = require('express')
const env = require('dotenv')
const tunnel = require('tunnel')
const { performance } = require('perf_hooks')
const http = require('http')
const { default: axios } = require('axios')
const app = express()

env.config();

// Standard Express setup
app.get('/', (req, res) => {
    res.json({ message: 'Network status server running.' });
})
app.get('get-nodes', (req, res) => {
    axios.get("https://slave.host-palace.net/portugal_cdn/get_node_list", (res) => {
        console.log(res);
    })
})

app.get('/now-status', (req, res) => {
    const url = "https://slave.host-palace.net/portugal_cdn/get_node_list";

    axios.get(url)
    .then(async response => {
        const data = response.data;

        // Filter where category === 4
        const ipList = data
          .filter(item => typeof item === "object" && item.category === 4)
          .map(item => item.ip);

        const results = [];

        for (const ip of ipList) {
            const TARGET_HOST = ip;
            const TARGET_PORT = 80;

            const PROXY_HOST = 'proxy.soax.com';
            const PROXY_PORT = 10220;

            const PROXY_USER = process.env.PROXY_USER || '';
            const PROXY_PASS = process.env.PROXY_PASS || '';

            const TIMEOUT_MS = 10000;

            // Await the measurement and push to results
            const result = await new Promise(resolve => {
                measureProxiedLatency(
                    TARGET_HOST,
                    TARGET_PORT,
                    PROXY_HOST,
                    PROXY_PORT,
                    PROXY_USER,
                    PROXY_PASS,
                    TIMEOUT_MS,
                    resolve
                );
            });

            results.push(result);
        }

        // ✅ Send ONE response
        res.json({
            status: "completed",
            count: results.length,
            results
        });
    })
    .catch(err => {
        console.error("Error:", err.message);
        res.status(500).json({ error: err.message });
    });
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
 * @param {function} resolve - The Promise resolver function.
 */
function measureProxiedLatency(
  targetHost,
  targetPort,
  proxyHost,
  proxyPort,
  user,
  pass,
  timeout,
  resolve
) {
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

  console.log(`\n📡 Measuring full RTT to ${targetHost}:${targetPort} via proxy`);

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
}

app.listen(3000, () => {
    console.log("Server is running at port 3000! Access /now-status to run the measurement.");
})
