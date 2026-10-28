'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const EMPTY = () => ({ repos: [], flows: [] });

/** Minimal JSON-file backed persistence for registered repositories and flows. */
class Store {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = this.load();
  }

  load() {
    if (!this.filePath || !fs.existsSync(this.filePath)) return EMPTY();
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      return {
        repos: Array.isArray(parsed.repos) ? parsed.repos : [],
        flows: Array.isArray(parsed.flows) ? parsed.flows : [],
      };
    } catch {
      return EMPTY();
    }
  }

  save() {
    if (!this.filePath) return;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.filePath);
  }

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

  listFlows() {
    return [...this.data.flows];
  }

  getFlow(id) {
    return this.data.flows.find((f) => f.id === id);
  }

  addFlow({ name, steps }) {
    const flow = { id: crypto.randomUUID(), name, steps, createdAt: new Date().toISOString() };
    this.data.flows.push(flow);
    this.save();
    return flow;
  }

  removeFlow(id) {
    const before = this.data.flows.length;
    this.data.flows = this.data.flows.filter((f) => f.id !== id);
    if (this.data.flows.length === before) return false;
    this.save();
    return true;
  }
}

module.exports = { Store };
