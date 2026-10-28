'use strict';

const crypto = require('node:crypto');

const VERSION = 'v1';
const IV_BYTES = 12;
const KEY_BYTES = 32;

/** Parses a 32-byte key given as base64 or hex. Throws on anything else. */
function parseKey(value, name = 'encryption key') {
  const raw = String(value || '').trim();
  let key = null;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) key = Buffer.from(raw, 'hex');
  else if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(raw)) key = Buffer.from(raw, 'base64');
  if (!key || key.length !== KEY_BYTES) {
    throw new Error(`${name} must be 32 bytes, encoded as base64 or 64 hex characters (generate one with: openssl rand -base64 32)`);
  }
  return key;
}

/** Short, non-secret identifier of a key so ciphertexts record which key encrypted them. */
function keyId(key) {
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 8);
}

/**
 * AES-256-GCM encryption of secrets at rest.
 * `aad` (additional authenticated data) binds a ciphertext to its context
 * (e.g. the owning user id) so it cannot be copied to another record.
 */
class SecretBox {
  constructor({ currentKey, previousKeys = [] }) {
    if (!Buffer.isBuffer(currentKey) || currentKey.length !== KEY_BYTES) throw new Error('currentKey must be a 32-byte Buffer');
    this.current = { id: keyId(currentKey), key: currentKey };
    this.keys = new Map([[this.current.id, currentKey]]);
    for (const key of previousKeys) this.keys.set(keyId(key), key);
  }

  encrypt(plaintext, aad) {
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.current.key, iv);
    cipher.setAAD(Buffer.from(String(aad)));
    const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [VERSION, this.current.id, iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join(':');
  }

  decrypt(payload, aad) {
    const parts = String(payload).split(':');
    if (parts.length !== 5 || parts[0] !== VERSION) throw new Error('Unsupported secret format');
    const [, id, iv, tag, ciphertext] = parts;
    const key = this.keys.get(id);
    if (!key) throw new Error('Secret was encrypted with an unknown key');
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
      decipher.setAAD(Buffer.from(String(aad)));
      decipher.setAuthTag(Buffer.from(tag, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]).toString('utf8');
    } catch {
      throw new Error('Secret could not be decrypted (tampered or wrong key)');
    }
  }

  /** True when the payload was encrypted with a key other than the current one. */
  needsRotation(payload) {
    return String(payload).split(':')[1] !== this.current.id;
  }
}

// ---- Password hashing (scrypt) ------------------------------------------------
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt:${SCRYPT.N}:${SCRYPT.r}:${SCRYPT.p}:${salt.toString('base64')}:${hash.toString('base64')}`;
}

const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString('hex'));

/** Verifies a password. Passing a missing hash still costs one scrypt run, so timing doesn't reveal whether a user exists. */
function verifyPassword(password, stored) {
  const parts = String(stored || DUMMY_HASH).split(':');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, salt, hash] = parts;
  const expected = Buffer.from(hash, 'base64');
  const actual = crypto.scryptSync(String(password), Buffer.from(salt, 'base64'), expected.length, { N: +N, r: +r, p: +p });
  return crypto.timingSafeEqual(actual, expected) && Boolean(stored);
}

module.exports = { SecretBox, parseKey, keyId, hashPassword, verifyPassword };
