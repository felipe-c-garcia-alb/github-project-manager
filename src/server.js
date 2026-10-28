'use strict';

const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const { createApp } = require('./app');
const { loadConfig } = require('./config');
const { GitHubClient } = require('./github');
const { Store } = require('./store');
const { FlowRunner } = require('./flowRunner');
const { SecretBox } = require('./crypto');
const { TokenService } = require('./tokens');
const { SessionStore } = require('./sessions');

let config;
try {
  config = loadConfig(process.env);
} catch (err) {
  console.error(`Configuration error: ${err.message}`);
  process.exit(1);
}

const store = new Store(config.dataFile);
const secretBox = new SecretBox({ currentKey: config.currentKey, previousKeys: config.previousKeys });
const tokens = new TokenService({
  store,
  secretBox,
  createGitHub: (token) => new GitHubClient({ token, baseUrl: config.githubApiUrl }),
});

const { rotated, unreadable } = tokens.rotateAll();
if (rotated) console.log(`Re-encrypted ${rotated} GitHub token(s) with the current encryption key.`);
if (unreadable) {
  console.warn(`${unreadable} stored GitHub token(s) cannot be decrypted with the configured keys; those users must save their token again.`);
}

const flowRunner = new FlowRunner({ githubForUser: (userId) => tokens.githubFor(userId), store });
const app = createApp({
  store,
  tokens,
  flowRunner,
  sessions: new SessionStore({ ttlMs: config.sessionTtlHours * 60 * 60 * 1000 }),
  allowedHosts: config.allowedHosts,
  allowSignup: config.allowSignup,
  requireHttps: config.requireHttps,
  trustProxy: config.trustProxy,
});

const server = config.tls
  ? https.createServer({ cert: fs.readFileSync(config.tls.certFile), key: fs.readFileSync(config.tls.keyFile) }, app)
  : http.createServer(app);

server.listen(config.port, config.host, () => {
  const scheme = config.tls ? 'https' : 'http';
  console.log(`GitHub Project Manager running at ${scheme}://${config.host}:${config.port}`);
  if (!config.tls && config.requireHttps && !config.trustProxy) {
    console.log('Note: serving plain HTTP. Only local (loopback) requests are accepted until TLS or a trusted HTTPS proxy is configured.');
  }
});

const shutdown = () => server.close(() => process.exit(0));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
