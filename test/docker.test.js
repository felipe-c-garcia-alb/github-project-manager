'use strict';

// Opt-in: DOCKER_TESTS=1 npm test  (needs a local Docker daemon)
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

test('container starts as non-root and passes its health check', { skip: process.env.DOCKER_TESTS !== '1', timeout: 300000 }, async (t) => {
  const image = 'github-project-manager:test';
  docker('build', '-t', image, path.join(__dirname, '..'));
  const name = `gpm-test-${crypto.randomBytes(4).toString('hex')}`;
  docker('run', '-d', '--name', name, '--health-interval=1s',
    '-e', `TOKEN_ENCRYPTION_KEY=${crypto.randomBytes(32).toString('base64')}`, image);
  t.after(() => docker('rm', '-f', name));

  let status = '';
  for (let i = 0; i < 30 && status !== 'healthy'; i += 1) {
    await new Promise((r) => setTimeout(r, 1000));
    status = docker('inspect', '--format', '{{.State.Health.Status}}', name);
  }
  assert.equal(status, 'healthy');
  assert.equal(docker('exec', name, 'id', '-un'), 'node');
});
