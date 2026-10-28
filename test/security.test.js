'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SecretBox, parseKey, hashPassword, verifyPassword } = require('../src/crypto');
const { loadConfig } = require('../src/config');
const { Store } = require('../src/store');
const { TokenService } = require('../src/tokens');

const key = () => crypto.randomBytes(32);

test('SecretBox encrypts and decrypts with the same AAD', () => {
  const box = new SecretBox({ currentKey: key() });
  const payload = box.encrypt('ghp_secret', 'github-token:u1');
  assert.ok(!payload.includes('ghp_secret'));
  assert.notEqual(payload, box.encrypt('ghp_secret', 'github-token:u1'), 'a fresh IV is used every time');
  assert.equal(box.decrypt(payload, 'github-token:u1'), 'ghp_secret');
});

test('SecretBox detects tampering, wrong AAD and wrong key', () => {
  const box = new SecretBox({ currentKey: key() });
  const payload = box.encrypt('ghp_secret', 'github-token:u1');
  const parts = payload.split(':');
  const ct = Buffer.from(parts[4], 'base64');
  ct[0] ^= 1;
  parts[4] = ct.toString('base64');
  assert.throws(() => box.decrypt(parts.join(':'), 'github-token:u1'));
  // A ciphertext copied to another user's record does not decrypt.
  assert.throws(() => box.decrypt(payload, 'github-token:u2'));
  assert.throws(() => new SecretBox({ currentKey: key() }).decrypt(payload, 'github-token:u1'));
});

test('SecretBox decrypts with previous keys and reports rotation is needed', () => {
  const oldKey = key();
  const payload = new SecretBox({ currentKey: oldKey }).encrypt('ghp_secret', 'a');
  const box = new SecretBox({ currentKey: key(), previousKeys: [oldKey] });
  assert.ok(box.needsRotation(payload));
  assert.equal(box.decrypt(payload, 'a'), 'ghp_secret');
  assert.ok(!box.needsRotation(box.encrypt('ghp_secret', 'a')));
});

test('TokenService.rotateAll re-encrypts tokens with the current key', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gpm-')), 'db.json');
  const createGitHub = () => ({ getAuthenticatedUser: async () => ({ login: 'octo' }) });
  const oldKey = key();
  const store = new Store(file);
  const user = store.addUser({ username: 'alice', passwordHash: hashPassword('correct horse battery') });
  const token = 'ghp_' + 'a'.repeat(36);
  await new TokenService({ store, secretBox: new SecretBox({ currentKey: oldKey }), createGitHub }).set(user.id, token);

  const newKey = key();
  const rotated = new TokenService({ store: new Store(file), secretBox: new SecretBox({ currentKey: newKey, previousKeys: [oldKey] }), createGitHub });
  assert.equal(rotated.rotateAll(), 1);
  // After rotation, the new key alone is enough.
  const after = new TokenService({ store: new Store(file), secretBox: new SecretBox({ currentKey: newKey }), createGitHub });
  assert.equal(after.get(user.id), token);
});

test('parseKey accepts base64 or hex 32-byte keys only', () => {
  const k = key();
  assert.deepEqual(parseKey(k.toString('base64')), k);
  assert.deepEqual(parseKey(k.toString('hex')), k);
  assert.throws(() => parseKey('too-short'));
  assert.throws(() => parseKey(crypto.randomBytes(16).toString('base64')));
});

test('passwords are hashed with a salt and verified', () => {
  const a = hashPassword('correct horse battery');
  assert.notEqual(a, hashPassword('correct horse battery'));
  assert.ok(verifyPassword('correct horse battery', a));
  assert.ok(!verifyPassword('wrong', a));
  assert.ok(!verifyPassword('anything', undefined));
});

test('loadConfig refuses plain-http GitHub API URLs and a missing key', () => {
  const env = { TOKEN_ENCRYPTION_KEY: key().toString('base64') };
  assert.equal(loadConfig(env).githubApiUrl, 'https://api.github.com');
  assert.throws(() => loadConfig({ ...env, GITHUB_API_URL: 'http://ghe.example.com/api/v3' }), /https/);
  assert.throws(() => loadConfig({}), /TOKEN_ENCRYPTION_KEY/);
  assert.throws(() => loadConfig({ ...env, TLS_CERT_FILE: '/x.pem' }), /TLS_KEY_FILE/);
  assert.equal(loadConfig(env).requireHttps, true);
  assert.equal(loadConfig({ ...env, TRUST_PROXY: '1' }).trustProxy, 1);
});

test('loadConfig reads the key from a Docker secret file', () => {
  const k = key();
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gpm-')), 'key');
  fs.writeFileSync(file, `${k.toString('base64')}\n`);
  assert.deepEqual(loadConfig({ TOKEN_ENCRYPTION_KEY_FILE: file }).currentKey, k);
});
