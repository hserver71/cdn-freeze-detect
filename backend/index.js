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

app.get('/now-status', async (req, res) => {
    // --- Configuration Variables ---
    // The Target Host and Port 
    const TARGET_HOST = 'x';
    const TARGET_PORT = 80;

    // 🛠️ Your HTTP/HTTP Proxy Details
    const PROXY_HOST = 'proxy.soax.com';
    const PROXY_PORT = 10220;

    // 🔑 PROXY AUTHENTICATION (MUST BE FILLED IN FOR COMMERCIAL PROXIES)
    // **CRITICAL: Replace these empty strings with your actual Soax credentials.**
    const PROXY_USER = process.env.PROXY_USER || ''; // Load from .env or set here
    const PROXY_PASS = process.env.PROXY_PASS || ''; // Load from .env or set here

    const TIMEOUT_MS = 10000; // 10 seconds timeout
    // -------------------------------

    // Convert the measurement function to return a Promise so we can await it
    const result = await new Promise(resolve => {
        measureProxiedLatency(TARGET_HOST, TARGET_PORT, PROXY_HOST, PROXY_PORT, PROXY_USER, PROXY_PASS, TIMEOUT_MS, resolve);
    });

    // Send the result back to the client
    res.json(result);
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
function measureProxiedLatency(targetHost, targetPort, proxyHost, proxyPort, user, pass, timeout, resolve) {
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

    console.log(`\n📡 Attempting connection to ${targetHost}:${targetPort} via proxy: ${proxyHost}:${proxyPort}`);

    try {
        // 1. Configure the tunnel agent (handles the HTTP CONNECT request)
        const proxyConfig = {
            host: proxyHost,
            port: proxyPort,
            headers: { 'User-Agent': 'Node.js-Network-Check' }
        };

        if (authString) {
            proxyConfig.proxyAuth = authString;
        }

        // Since the target is port 80 (HTTP), we use httpOverHttp
        const tunnelingAgent = tunnel.httpOverHttp({ proxy: proxyConfig });

        // 2. Define the request options
        const requestOptions = {
            method: 'HEAD',
            host: targetHost,
            port: targetPort,
            agent: tunnelingAgent,
            timeout: timeout
        };

        // 3. Initiate the Request, which triggers the TCP CONNECT tunnel
        const req = http.request(requestOptions, (res) => {
            const endTime = performance.now();
            const rtt = (endTime - startTime).toFixed(2);
            resultTemplate.rtt = `${rtt}ms`;

            // Check for proxy-side errors (400-level codes returned by the proxy)
            if (res.statusCode >= 400 && res.statusCode < 500) {
                resultTemplate.status = 'proxy_rejected';
                resultTemplate.error = res.statusCode;

                if (res.statusCode === 407) {
                    resultTemplate.message = 'Proxy Authentication Required (407). Check PROXY_USER and PROXY_PASS.';
                } else {
                    resultTemplate.message = `Proxy rejected connection with HTTP Status: ${res.statusCode}.`;
                }
            } else {
                // Success: TCP tunnel established and target responded to HEAD request
                resultTemplate.status = 'success';
                resultTemplate.message = 'Connection via proxy successful.';
            }

            res.resume(); // Consume the response data
            resolve(resultTemplate);
        });

        // Error Handling (network errors like DNS, ECONNREFUSED, or the dreaded 'socket hang up')
        req.on('error', (err) => {
            const duration = (performance.now() - startTime).toFixed(2);
            resultTemplate.rtt = `${duration}ms`;
            resultTemplate.status = 'failed';

            if (err.message === 'socket hang up') {
                // This is the common case for unauthenticated/rejected proxy connections
                resultTemplate.error = 'SocketHangUp';
                resultTemplate.message = 'The proxy dropped the connection abruptly. **Likely cause: Missing or invalid proxy credentials.**';
            } else {
                resultTemplate.error = err.code || 'NetworkError';
                resultTemplate.message = err.message;
            }
            resolve(resultTemplate);
        });

        // Timeout Handling
        req.on('timeout', () => {
            const duration = (performance.now() - startTime).toFixed(2);
            req.destroy();
            resultTemplate.rtt = `${duration}ms`;
            resultTemplate.status = 'timeout';
            resultTemplate.error = 'ETIMEOUT';
            resultTemplate.message = `Connection timed out after ${timeout}ms.`;
            resolve(resultTemplate);
        });

        req.end();

    } catch (e) {
        resultTemplate.status = 'error';
        resultTemplate.error = 'ScriptSetupError';
        resultTemplate.message = `Critical initialization error: ${e.message}`;
        resolve(resultTemplate);
    }
}

app.listen(3000, () => {
    console.log("Server is running at port 3000! Access /now-status to run the measurement.");
})
