'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parseKey } = require('./crypto');

/** Reads VAR from the environment, or from the file named by VAR_FILE (Docker secrets). */
function readSecret(env, name) {
  const file = env[`${name}_FILE`];
  if (file) return fs.readFileSync(file, 'utf8').trim();
  return env[name] ? String(env[name]).trim() : '';
}

const bool = (value, fallback) => {
  if (value === undefined || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value));
};

const list = (value) => String(value || '').split(',').map((s) => s.trim()).filter(Boolean);

/** Builds the runtime configuration and validates it. Throws with a readable message on invalid settings. */
function loadConfig(env = process.env) {
  const githubApiUrl = (env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '');
  let parsedApiUrl;
  try {
    parsedApiUrl = new URL(githubApiUrl);
  } catch {
    throw new Error('GITHUB_API_URL is not a valid URL');
  }
  if (parsedApiUrl.protocol !== 'https:') {
    throw new Error('GITHUB_API_URL must use https:// so GitHub tokens are never sent unencrypted');
  }

  const keyValue = readSecret(env, 'TOKEN_ENCRYPTION_KEY');
  if (!keyValue) {
    throw new Error('TOKEN_ENCRYPTION_KEY (or TOKEN_ENCRYPTION_KEY_FILE) is required. Generate one with: openssl rand -base64 32');
  }
  const currentKey = parseKey(keyValue, 'TOKEN_ENCRYPTION_KEY');
  const previousKeys = list(readSecret(env, 'TOKEN_ENCRYPTION_PREVIOUS_KEYS'))
    .map((k, i) => parseKey(k, `TOKEN_ENCRYPTION_PREVIOUS_KEYS[${i}]`));

  const tlsCertFile = env.TLS_CERT_FILE || '';
  const tlsKeyFile = env.TLS_KEY_FILE || '';
  if (Boolean(tlsCertFile) !== Boolean(tlsKeyFile)) {
    throw new Error('TLS_CERT_FILE and TLS_KEY_FILE must be set together');
  }

  let trustProxy = env.TRUST_PROXY || '';
  if (/^(true|false)$/i.test(trustProxy)) trustProxy = /^true$/i.test(trustProxy);
  else if (/^\d+$/.test(trustProxy)) trustProxy = Number(trustProxy);

  return {
    port: Number.parseInt(env.PORT, 10) || 3000,
    host: env.HOST || '127.0.0.1',
    dataFile: env.DATA_FILE || path.join(__dirname, '..', 'data', 'db.json'),
    githubApiUrl,
    currentKey,
    previousKeys,
    requireHttps: bool(env.REQUIRE_HTTPS, true),
    trustProxy: trustProxy === '' ? false : trustProxy,
    allowedHosts: list(env.ALLOWED_HOSTS),
    allowSignup: bool(env.ALLOW_SIGNUP, false),
    sessionTtlHours: Number(env.SESSION_TTL_HOURS) > 0 ? Number(env.SESSION_TTL_HOURS) : 12,
    tls: tlsCertFile ? { certFile: tlsCertFile, keyFile: tlsKeyFile } : null,
  };
}

module.exports = { loadConfig, readSecret };
