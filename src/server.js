'use strict';

const path = require('node:path');
const { createApp } = require('./app');
const { GitHubClient } = require('./github');
const { Store } = require('./store');
const { FlowRunner } = require('./flowRunner');

const token = process.env.GITHUB_TOKEN || '';
const port = Number.parseInt(process.env.PORT, 10) || 3000;
const host = process.env.HOST || '127.0.0.1';
const dataFile = process.env.DATA_FILE || path.join(__dirname, '..', 'data', 'db.json');

if (!token) {
  console.warn('GITHUB_TOKEN is not set: only public data is readable and write operations will fail.');
}

const github = new GitHubClient({ token, baseUrl: process.env.GITHUB_API_URL || undefined });
const store = new Store(dataFile);
const flowRunner = new FlowRunner({ github });
const allowedHosts = (process.env.ALLOWED_HOSTS || '').split(',').map((h) => h.trim()).filter(Boolean);
const app = createApp({ github, store, flowRunner, hasToken: Boolean(token), allowedHosts });

app.listen(port, host, () => {
  console.log(`GitHub Project Manager running at http://${host}:${port}`);
});
