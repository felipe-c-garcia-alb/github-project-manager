'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const EMPTY = () => ({ repos: [], flows: [], users: [], executions: [] });

/**
 * JSON-file persistence for repositories (shared), users, flows and flow
 * executions (owned by a user). GitHub tokens are stored only in encrypted form.
 * The file is written atomically (temp file + rename) and is readable only by its owner.
 */
class Store {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = this.load();
  }

  load() {
    if (!this.filePath || !fs.existsSync(this.filePath)) return EMPTY();
    const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    const data = EMPTY();
    for (const key of Object.keys(data)) {
      if (Array.isArray(parsed[key])) data[key] = parsed[key];
    }
    return data;
  }

  save() {
    if (!this.filePath) return;
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, this.filePath);
  }

  // ---- Repositories (shared) ------------------------------------------------
  listRepos() {
    return [...this.data.repos];
  }

  findRepo(owner, repo) {
    return this.data.repos.find(
      (r) => r.owner.toLowerCase() === String(owner).toLowerCase() && r.repo.toLowerCase() === String(repo).toLowerCase(),
    );
  }

  addRepo(entry) {
    const existing = this.findRepo(entry.owner, entry.repo);
    if (existing) return existing;
    const record = { ...entry, addedAt: new Date().toISOString() };
    this.data.repos.push(record);
    this.save();
    return record;
  }

  removeRepo(owner, repo) {
    const existing = this.findRepo(owner, repo);
    if (!existing) return false;
    this.data.repos = this.data.repos.filter((r) => r !== existing);
    this.save();
    return true;
  }

  // ---- Users ----------------------------------------------------------------
  countUsers() {
    return this.data.users.length;
  }

  listUsers() {
    return [...this.data.users];
  }

  getUser(id) {
    return this.data.users.find((u) => u.id === id);
  }

  findUserByName(username) {
    const name = String(username).toLowerCase();
    return this.data.users.find((u) => u.username.toLowerCase() === name);
  }

  addUser({ username, passwordHash }) {
    const user = { id: crypto.randomUUID(), username, passwordHash, githubToken: null, createdAt: new Date().toISOString() };
    this.data.users.push(user);
    this.save();
    return user;
  }

  /** `githubToken` is { ciphertext, last4, githubLogin, updatedAt } or null. */
  setUserToken(id, githubToken) {
    const user = this.getUser(id);
    if (!user) return null;
    user.githubToken = githubToken;
    this.save();
    return user;
  }

  // ---- Flows (owned by a user) ----------------------------------------------
  listFlows(ownerId) {
    return this.data.flows.filter((f) => f.ownerId === ownerId);
  }

  getFlow(id, ownerId) {
    return this.data.flows.find((f) => f.id === id && f.ownerId === ownerId);
  }

  addFlow({ name, steps, ownerId }) {
    const flow = { id: crypto.randomUUID(), ownerId, name, steps, createdAt: new Date().toISOString() };
    this.data.flows.push(flow);
    this.save();
    return flow;
  }

  removeFlow(id, ownerId) {
    const before = this.data.flows.length;
    this.data.flows = this.data.flows.filter((f) => !(f.id === id && f.ownerId === ownerId));
    if (this.data.flows.length === before) return false;
    this.save();
    return true;
  }

  // ---- Flow executions --------------------------------------------------------
  loadExecutions() {
    return this.data.executions;
  }

  saveExecutions(executions) {
    this.data.executions = executions;
    this.save();
  }
}

module.exports = { Store };
