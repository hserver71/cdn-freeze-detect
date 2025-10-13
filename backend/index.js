import express from 'express'
import net from 'net';
import env from 'dotenv'
import { HttpsProxyAgent } from 'https-proxy-agent';
import tunnel from 'tunnel'
import { performance } from 'perf_hooks';
import http from 'http';
const app = express()
env.config();

app.get('/', (req, res) => {
    res.send('Hello World')
})
1
app.get('/now-status', (req, res) => {
    // The Target Host and Port 
    const TARGET_HOST = '93.119.105.170';
    const TARGET_PORT = 80; // Standard port for tunneling, change if needed

    // 🛠️ Your HTTP/HTTPS Proxy Details
    const PROXY_HOST = 'proxy.soax.com';
    const PROXY_PORT = 10220;

    // 🔑 PROXY AUTHENTICATION (REQUIRED FOR MOST COMMERCIAL PROXIES)
    // If your proxy needs authentication, fill these in. Otherwise, leave them empty strings.
    const PROXY_USER = ''; // e.g., 'soax_username'
    const PROXY_PASS = ''; // e.g., 'your_password123'

    const TIMEOUT_MS = 10000; // 10 seconds timeout

    // -----------------------------------------------------------
    // 🛠️ NETWORK MEASUREMENT FUNCTION
    // -----------------------------------------------------------

    function measureProxiedLatency(targetHost, targetPort, proxyHost, proxyPort, user, pass) {
        const authString = (user && pass) ? `${user}:${pass}` : '';
        console.log(`📡 Attempting TCP connection to ${targetHost}:${targetPort} via proxy: ${proxyHost}:${proxyPort}`);

        const startTime = performance.now();

        try {
            // 1. Configure the tunnel agent (handles the HTTP CONNECT request)
            const proxyConfig = {
                host: proxyHost,
                port: proxyPort,
                headers: {
                    'User-Agent': 'Node.js-Network-Check'
                }
            };

            if (authString) {
                proxyConfig.proxyAuth = authString;
            }

            const tunnelingAgent = tunnel.httpsOverHttp({ proxy: proxyConfig });

            // 2. Define the request options to initiate the tunnel
            const requestOptions = {
                method: 'HEAD',
                host: targetHost,
                port: targetPort,
                agent: tunnelingAgent,
                timeout: TIMEOUT_MS
            };

            // 3. Initiate the Request, which triggers the TCP CONNECT tunnel
            const req = http.request(requestOptions, (res) => {
                const endTime = performance.now();
                const rtt = (endTime - startTime).toFixed(2);

                // Check for proxy-side errors (400-level codes)
                if (res.statusCode >= 400 && res.statusCode < 500) {
                    console.error(`\n❌ Proxy Rejected Connection. HTTP Status: **${res.statusCode}**`);
                    if (res.statusCode === 407) {
                        console.error('Error Diagnosis: **Proxy Authentication Required (407).** Check your PROXY_USER and PROXY_PASS.');
                    } else if (res.statusCode === 403 || res.statusCode === 422) {
                        console.error('Error Diagnosis: **Access Denied or Unprocessable Entity (403/422).** The proxy rules are blocking the target.');
                    } else {
                        console.error('Error Diagnosis: The proxy service is actively blocking this request or target.');
                    }
                } else {
                    console.log(`\n✅ Connection via proxy successful (TCP Handshake completed).`);
                    console.log(`Target: ${targetHost}:${targetPort}`);
                    console.log(`Measured Network Status (RTT): **${rtt}ms**`);
                }

                res.resume();
            });

            // Error Handling (network errors before proxy response)
            req.on('error', (err) => {
                const duration = (performance.now() - startTime).toFixed(2);
                console.error(`\n❌ Connection Failed. Attempt Duration: ${duration}ms`);
                console.error(`Error Details: **${err.message}**`);
            });

            // Timeout Handling
            req.on('timeout', () => {
                const duration = (performance.now() - startTime).toFixed(2);
                console.error(`\n❌ Connection Timed Out (${TIMEOUT_MS}ms). Attempt Duration: ${duration}ms`);
                req.destroy();
            });

            req.end();

        } catch (e) {
            console.error(`\n❌ Script Setup Error: ${e.message}`);
        }
    }

    // Execute the measurement
    measureProxiedLatency(TARGET_HOST, TARGET_PORT, PROXY_HOST, PROXY_PORT, PROXY_USER, PROXY_PASS);
})

app.listen(3000, () => {
    console.log("Server is running at port 3000!");
})