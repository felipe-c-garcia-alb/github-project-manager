'use strict';

class GitHubError extends Error {
  constructor(message, status, details) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
    this.details = details;
  }
}

/**
 * Parses the "last" page number from a GitHub Link header.
 * Returns null when no "last" relation is present.
 */
function parseLastPage(linkHeader) {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(',')) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="last"/);
    if (match) {
      const page = new URL(match[1]).searchParams.get('page');
      const n = Number.parseInt(page, 10);
      return Number.isFinite(n) ? n : null;
    }
  }
  return null;
}

function encodeRef(ref) {
  return String(ref)
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

class GitHubClient {
  constructor({ token, baseUrl = 'https://api.github.com', fetchImpl = globalThis.fetch } = {}) {
    this.token = token || '';
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.fetch = fetchImpl;
  }

  repoPath(owner, repo) {
    return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  }

  async request(path, { method = 'GET', query, body, accept = 'application/vnd.github+json', raw = false } = {}) {
    const url = new URL(this.baseUrl + path);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
      }
    }
    const headers = {
      Accept: accept,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'github-project-manager',
    };
    if (this.token) headers.Authorization = 'Bearer ' + this.token;
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    const res = await this.fetch(url.toString(), {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      redirect: 'follow',
    });

    if (!res.ok) {
      let details;
      try {
        details = await res.json();
      } catch {
        details = undefined;
      }
      const message = (details && details.message) || `GitHub API request failed with status ${res.status}`;
      throw new GitHubError(message, res.status, details);
    }
    if (raw) return res;
    if (res.status === 204) return null;
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  /** Counts items of a paginated list endpoint using per_page=1 and the Link header. */
  async count(path, query = {}) {
    const res = await this.request(path, { query: { ...query, per_page: 1 }, raw: true });
    const last = parseLastPage(res.headers.get('link'));
    if (last !== null) return last;
    const data = await res.json();
    return Array.isArray(data) ? data.length : 0;
  }

  getAuthenticatedUser() {
    return this.request('/user');
  }

  getRepo(owner, repo) {
    return this.request(this.repoPath(owner, repo));
  }

  async getRepoSummary(owner, repo) {
    const base = this.repoPath(owner, repo);
    const [branches, tags, openPullRequests, workflows, runs, inProgress] = await Promise.all([
      this.count(`${base}/branches`),
      this.count(`${base}/tags`),
      this.count(`${base}/pulls`, { state: 'open' }),
      this.request(`${base}/actions/workflows`, { query: { per_page: 1 } }),
      this.request(`${base}/actions/runs`, { query: { per_page: 1 } }),
      this.request(`${base}/actions/runs`, { query: { per_page: 1, status: 'in_progress' } }),
    ]);
    return {
      branches,
      tags,
      openPullRequests,
      workflows: workflows ? workflows.total_count : 0,
      workflowRuns: runs ? runs.total_count : 0,
      runningWorkflowRuns: inProgress ? inProgress.total_count : 0,
    };
  }

  listPullRequests(owner, repo, { state = 'open', perPage = 50 } = {}) {
    return this.request(`${this.repoPath(owner, repo)}/pulls`, {
      query: { state, per_page: perPage, sort: 'updated', direction: 'desc' },
    });
  }

  async listWorkflows(owner, repo) {
    const data = await this.request(`${this.repoPath(owner, repo)}/actions/workflows`, { query: { per_page: 100 } });
    return data ? data.workflows : [];
  }

  async listRuns(owner, repo, { workflowId, event, branch, perPage = 20 } = {}) {
    const base = this.repoPath(owner, repo);
    const path = workflowId
      ? `${base}/actions/workflows/${encodeURIComponent(workflowId)}/runs`
      : `${base}/actions/runs`;
    const data = await this.request(path, { query: { per_page: perPage, event, branch } });
    return data ? data.workflow_runs : [];
  }

  getRun(owner, repo, runId) {
    return this.request(`${this.repoPath(owner, repo)}/actions/runs/${encodeURIComponent(runId)}`);
  }

  async listJobs(owner, repo, runId) {
    const data = await this.request(
      `${this.repoPath(owner, repo)}/actions/runs/${encodeURIComponent(runId)}/jobs`,
      { query: { per_page: 100 } },
    );
    return data ? data.jobs : [];
  }

  /**
   * Returns the plain text logs of a job, or null when GitHub has no logs yet
   * (e.g. the job is still queued / in progress).
   */
  async getJobLogs(owner, repo, jobId) {
    try {
      const res = await this.request(
        `${this.repoPath(owner, repo)}/actions/jobs/${encodeURIComponent(jobId)}/logs`,
        { raw: true },
      );
      return await res.text();
    } catch (err) {
      if (err instanceof GitHubError && (err.status === 404 || err.status === 410)) return null;
      throw err;
    }
  }

  listBranches(owner, repo) {
    return this.request(`${this.repoPath(owner, repo)}/branches`, { query: { per_page: 100 } });
  }

  async createBranch(owner, repo, name, fromBranch) {
    const base = this.repoPath(owner, repo);
    const source = await this.request(`${base}/git/ref/heads/${encodeRef(fromBranch)}`);
    return this.request(`${base}/git/refs`, {
      method: 'POST',
      body: { ref: `refs/heads/${name}`, sha: source.object.sha },
    });
  }

  deleteBranch(owner, repo, name) {
    return this.request(`${this.repoPath(owner, repo)}/git/refs/heads/${encodeRef(name)}`, { method: 'DELETE' });
  }

  dispatchWorkflow(owner, repo, workflowId, ref, inputs = {}) {
    return this.request(
      `${this.repoPath(owner, repo)}/actions/workflows/${encodeURIComponent(workflowId)}/dispatches`,
      { method: 'POST', body: { ref, inputs } },
    );
  }
}

module.exports = { GitHubClient, GitHubError, parseLastPage };
