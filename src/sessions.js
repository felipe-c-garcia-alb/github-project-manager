'use strict';

const crypto = require('node:crypto');

/** In-memory sessions. Restarting the server signs everybody out. */
class SessionStore {
  constructor({ ttlMs = 12 * 60 * 60 * 1000, now = () => Date.now() } = {}) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.sessions = new Map();
  }

  create(userId) {
    this.prune();
    const id = crypto.randomBytes(32).toString('base64url');
    this.sessions.set(id, { userId, expiresAt: this.now() + this.ttlMs });
    return id;
  }

  get(id) {
    if (typeof id !== 'string' || !id) return null;
    const session = this.sessions.get(id);
    if (!session) return null;
    if (session.expiresAt <= this.now()) {
      this.sessions.delete(id);
      return null;
    }
    return session.userId;
  }

  destroy(id) {
    this.sessions.delete(id);
  }

  prune() {
    const t = this.now();
    for (const [id, s] of this.sessions) if (s.expiresAt <= t) this.sessions.delete(id);
  }
}

module.exports = { SessionStore };
