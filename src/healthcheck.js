'use strict';

// Docker HEALTHCHECK: probes /api/health on the local server (HTTP or HTTPS).
const http = require('node:http');
const https = require('node:https');

const useTls = Boolean(process.env.TLS_CERT_FILE);
const client = useTls ? https : http;
const req = client.get({
  host: '127.0.0.1',
  port: Number.parseInt(process.env.PORT, 10) || 3000,
  path: '/api/health',
  timeout: 3000,
  // Local probe of our own certificate, which may be self-signed or issued for another host name.
  rejectUnauthorized: false,
}, (res) => {
  res.resume();
  process.exit(res.statusCode === 200 ? 0 : 1);
});
req.on('timeout', () => req.destroy());
req.on('error', () => process.exit(1));
