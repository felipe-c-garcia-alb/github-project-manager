'use strict';

const TOKEN_RE = /^[A-Za-z0-9_]{20,255}$/;

class NoTokenError extends Error {
  constructor() {
    super('No GitHub token configured. Add your token on the Settings page.');
    this.status = 412;
  }
}

class InvalidTokenError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

/**
 * Manages each user's GitHub token. Tokens are encrypted with AES-256-GCM
 * (bound to the user id) before they are stored and are only decrypted in
 * memory to build a GitHub client. The plaintext is never returned by the API.
 */
class TokenService {
  constructor({ store, secretBox, createGitHub }) {
    this.store = store;
    this.secretBox = secretBox;
    this.createGitHub = createGitHub;
  }

  static aad(userId) {
    return `github-token:${userId}`;
  }

  /** Validates the token against GitHub, then stores it encrypted. Returns the public description. */
  async set(userId, token) {
    if (typeof token !== 'string' || !TOKEN_RE.test(token.trim())) {
      throw new InvalidTokenError('That does not look like a GitHub token');
    }
    const value = token.trim();
    let githubUser;
    try {
      githubUser = await this.createGitHub(value).getAuthenticatedUser();
    } catch (err) {
      if (err && err.status === 401) throw new InvalidTokenError('GitHub rejected this token');
      throw err;
    }
    const user = this.store.setUserToken(userId, {
      ciphertext: this.secretBox.encrypt(value, TokenService.aad(userId)),
      last4: value.slice(-4),
      githubLogin: githubUser && githubUser.login ? githubUser.login : null,
      updatedAt: new Date().toISOString(),
    });
    return TokenService.describe(user);
  }

  clear(userId) {
    this.store.setUserToken(userId, null);
  }

  /** Returns the decrypted token or null. */
  get(userId) {
    const user = this.store.getUser(userId);
    if (!user || !user.githubToken) return null;
    return this.secretBox.decrypt(user.githubToken.ciphertext, TokenService.aad(userId));
  }

  /** Returns a GitHub client authenticated as the user. Throws NoTokenError when none is configured. */
  githubFor(userId) {
    const token = this.get(userId);
    if (!token) throw new NoTokenError();
    return this.createGitHub(token);
  }

  /** Re-encrypts tokens that were encrypted with a previous key. Returns how many were rotated. */
  rotateAll() {
    let rotated = 0;
    for (const user of this.store.listUsers()) {
      if (user.githubToken && this.secretBox.needsRotation(user.githubToken.ciphertext)) {
        const plaintext = this.secretBox.decrypt(user.githubToken.ciphertext, TokenService.aad(user.id));
        this.store.setUserToken(user.id, {
          ...user.githubToken,
          ciphertext: this.secretBox.encrypt(plaintext, TokenService.aad(user.id)),
        });
        rotated += 1;
      }
    }
    return rotated;
  }

  /** Public, non-secret information about a user's token. */
  static describe(user) {
    const t = user && user.githubToken;
    if (!t) return { set: false };
    return { set: true, last4: t.last4, githubLogin: t.githubLogin, updatedAt: t.updatedAt };
  }
}

module.exports = { TokenService, NoTokenError, InvalidTokenError };
