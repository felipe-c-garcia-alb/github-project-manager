'use strict';

const path = require('node:path');
const express = require('express');
const { GitHubError } = require('./github');

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;
const WORKFLOW_RE = /^[A-Za-z0-9._-]{1,255}$/;
const NUMERIC_RE = /^\d{1,20}$/;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function isValidRefName(name) {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name.length <= 255 &&
    !/[\s~^:?*[\\\x00-\x1f\x7f]/.test(name) &&
    !name.includes('..') &&
    !name.includes('@{') &&
    !name.endsWith('.') &&
    !name.endsWith('.lock') &&
    // No empty components (leading/trailing/double slash) and no component starting with "."
    name.split('/').every((segment) => segment.length > 0 && !segment.startsWith('.'))
  );
}

function assertRepoName(owner, repo) {
  if (!OWNER_RE.test(owner || '') || !REPO_RE.test(repo || '') || repo === '.' || repo === '..') {
    throw new HttpError(400, 'Invalid repository name');
  }
}

function parseInputs(inputs) {
  if (inputs === undefined || inputs === null || inputs === '') return {};
  if (typeof inputs !== 'object' || Array.isArray(inputs)) {
    throw new HttpError(400, 'inputs must be an object');
  }
  const out = {};
  for (const [key, value] of Object.entries(inputs)) {
    out[key] = typeof value === 'string' ? value : JSON.stringify(value);
  }
  return out;
}

function isIpOrLocalhost(hostname) {
  return hostname === 'localhost' || /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.startsWith('[');
}

/**
 * Protects the API against DNS rebinding (unexpected Host header) and
 * cross-site request forgery (mutating requests must carry a custom header,
 * which browsers only allow cross-origin after a CORS preflight that this
 * server never approves).
 */
function requestGuard({ allowedHosts = [] } = {}) {
  const allowed = new Set(allowedHosts.map((h) => h.toLowerCase()));
  return (req, res, next) => {
    const hostname = String(req.hostname || '').toLowerCase();
    if (!isIpOrLocalhost(hostname) && !allowed.has(hostname)) {
      res.status(403).json({ error: 'Host not allowed. Add it to ALLOWED_HOSTS.' });
      return;
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.get('X-Requested-With') !== 'XMLHttpRequest') {
      res.status(403).json({ error: 'Missing X-Requested-With header' });
      return;
    }
    next();
  };
}

/** Simple fixed-window, per-client rate limiter for the API. */
function rateLimit({ windowMs = 60 * 1000, max = 300 } = {}) {
  const hits = new Map();
  return (req, res, next) => {
    const nowMs = Date.now();
    const key = req.ip || 'unknown';
    let entry = hits.get(key);
    if (!entry || nowMs - entry.start >= windowMs) {
      entry = { start: nowMs, count: 0 };
      hits.set(key, entry);
      if (hits.size > 10000) {
        for (const [k, v] of hits) if (nowMs - v.start >= windowMs) hits.delete(k);
      }
    }
    entry.count += 1;
    if (entry.count > max) {
      res.status(429).json({ error: 'Too many requests' });
      return;
    }
    next();
  };
}

function createApp({ github, store, flowRunner, hasToken = true, rateLimitOptions, allowedHosts } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.static(path.join(__dirname, '..', 'public')));

  const api = express.Router();
  api.use(rateLimit(rateLimitOptions));
  api.use(requestGuard({ allowedHosts }));
  api.use(express.json({ limit: '100kb' }));
  api.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  const wrap = (fn) => async (req, res, next) => {
    try {
      await fn(req, res, next);
    } catch (err) {
      next(err);
    }
  };

  // Only registered repositories can be accessed through the API so the
  // server token cannot be used as an open proxy to arbitrary repositories.
  const registered = (req, res, next) => {
    const { owner, repo } = req.params;
    assertRepoName(owner, repo);
    const entry = store.findRepo(owner, repo);
    if (!entry) throw new HttpError(404, 'Repository is not registered');
    req.repoEntry = entry;
    next();
  };

  api.get('/config', (req, res) => {
    res.json({ hasToken });
  });

  // ---- Repository registration -------------------------------------------
  api.get('/repos', (req, res) => {
    res.json(store.listRepos());
  });

  api.post('/repos', wrap(async (req, res) => {
    const body = req.body || {};
    let { owner, repo } = body;
    if (typeof body.fullName === 'string') {
      const cleaned = body.fullName.trim().slice(0, 300).replace(/^https?:\/\/github\.com\//i, '');
      [owner, repo] = cleaned.split('/').filter(Boolean);
      if (repo && repo.endsWith('.git')) repo = repo.slice(0, -4);
    }
    assertRepoName(owner, repo);
    const info = await github.getRepo(owner, repo);
    const entry = store.addRepo({
      owner: info.owner.login,
      repo: info.name,
      fullName: info.full_name,
      htmlUrl: info.html_url,
      defaultBranch: info.default_branch,
    });
    res.status(201).json(entry);
  }));

  api.delete('/repos/:owner/:repo', registered, (req, res) => {
    store.removeRepo(req.repoEntry.owner, req.repoEntry.repo);
    res.status(204).end();
  });

  // ---- Dashboard -----------------------------------------------------------
  api.get('/dashboard', wrap(async (req, res) => {
    const repos = store.listRepos();
    const results = await Promise.all(repos.map(async (r) => {
      try {
        return { ...r, summary: await github.getRepoSummary(r.owner, r.repo), error: null };
      } catch (err) {
        return { ...r, summary: null, error: err.message };
      }
    }));
    res.json(results);
  }));

  api.get('/repos/:owner/:repo/summary', registered, wrap(async (req, res) => {
    res.json(await github.getRepoSummary(req.repoEntry.owner, req.repoEntry.repo));
  }));

  // ---- Pull requests -------------------------------------------------------
  api.get('/repos/:owner/:repo/pulls', registered, wrap(async (req, res) => {
    const state = ['open', 'closed', 'all'].includes(req.query.state) ? req.query.state : 'open';
    const pulls = await github.listPullRequests(req.repoEntry.owner, req.repoEntry.repo, { state });
    res.json(pulls.map((p) => ({
      number: p.number,
      title: p.title,
      state: p.state,
      draft: p.draft,
      merged: Boolean(p.merged_at),
      htmlUrl: p.html_url,
      user: p.user && p.user.login,
      head: p.head && p.head.ref,
      base: p.base && p.base.ref,
      createdAt: p.created_at,
      updatedAt: p.updated_at,
    })));
  }));

  // ---- Actions -------------------------------------------------------------
  api.get('/repos/:owner/:repo/workflows', registered, wrap(async (req, res) => {
    const workflows = await github.listWorkflows(req.repoEntry.owner, req.repoEntry.repo);
    res.json(workflows.map((w) => ({
      id: w.id,
      name: w.name,
      path: w.path,
      state: w.state,
      htmlUrl: w.html_url,
    })));
  }));

  const mapRun = (r) => ({
    id: r.id,
    name: r.name,
    displayTitle: r.display_title,
    status: r.status,
    conclusion: r.conclusion,
    event: r.event,
    branch: r.head_branch,
    runNumber: r.run_number,
    htmlUrl: r.html_url,
    actor: r.actor && r.actor.login,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  });

  api.get('/repos/:owner/:repo/runs', registered, wrap(async (req, res) => {
    const runs = await github.listRuns(req.repoEntry.owner, req.repoEntry.repo, { perPage: 30 });
    res.json(runs.map(mapRun));
  }));

  api.get('/repos/:owner/:repo/runs/:runId', registered, wrap(async (req, res) => {
    if (!NUMERIC_RE.test(req.params.runId)) throw new HttpError(400, 'Invalid run id');
    res.json(mapRun(await github.getRun(req.repoEntry.owner, req.repoEntry.repo, req.params.runId)));
  }));

  api.get('/repos/:owner/:repo/runs/:runId/jobs', registered, wrap(async (req, res) => {
    if (!NUMERIC_RE.test(req.params.runId)) throw new HttpError(400, 'Invalid run id');
    const jobs = await github.listJobs(req.repoEntry.owner, req.repoEntry.repo, req.params.runId);
    res.json(jobs.map((j) => ({
      id: j.id,
      name: j.name,
      status: j.status,
      conclusion: j.conclusion,
      htmlUrl: j.html_url,
      startedAt: j.started_at,
      completedAt: j.completed_at,
      steps: (j.steps || []).map((s) => ({
        number: s.number,
        name: s.name,
        status: s.status,
        conclusion: s.conclusion,
      })),
    })));
  }));

  api.get('/repos/:owner/:repo/jobs/:jobId/logs', registered, wrap(async (req, res) => {
    if (!NUMERIC_RE.test(req.params.jobId)) throw new HttpError(400, 'Invalid job id');
    const logs = await github.getJobLogs(req.repoEntry.owner, req.repoEntry.repo, req.params.jobId);
    res.json({ available: logs !== null, logs: logs || '' });
  }));

  api.post('/repos/:owner/:repo/workflows/:workflowId/dispatches', registered, wrap(async (req, res) => {
    const { workflowId } = req.params;
    if (!WORKFLOW_RE.test(workflowId)) throw new HttpError(400, 'Invalid workflow id');
    const body = req.body || {};
    const ref = body.ref || req.repoEntry.defaultBranch;
    if (!isValidRefName(ref)) throw new HttpError(400, 'Invalid ref');
    await github.dispatchWorkflow(req.repoEntry.owner, req.repoEntry.repo, workflowId, ref, parseInputs(body.inputs));
    res.status(202).json({ dispatched: true, ref });
  }));

  // ---- Branches ------------------------------------------------------------
  api.get('/repos/:owner/:repo/branches', registered, wrap(async (req, res) => {
    const branches = await github.listBranches(req.repoEntry.owner, req.repoEntry.repo);
    res.json(branches.map((b) => ({
      name: b.name,
      sha: b.commit && b.commit.sha,
      protected: Boolean(b.protected),
      isDefault: b.name === req.repoEntry.defaultBranch,
    })));
  }));

  api.post('/repos/:owner/:repo/branches', registered, wrap(async (req, res) => {
    const { name } = req.body || {};
    const from = (req.body && req.body.from) || req.repoEntry.defaultBranch;
    if (!isValidRefName(name)) throw new HttpError(400, 'Invalid branch name');
    if (!isValidRefName(from)) throw new HttpError(400, 'Invalid source branch');
    await github.createBranch(req.repoEntry.owner, req.repoEntry.repo, name, from);
    res.status(201).json({ name, from });
  }));

  api.delete('/repos/:owner/:repo/branches', registered, wrap(async (req, res) => {
    const { name } = req.query;
    if (!isValidRefName(name)) throw new HttpError(400, 'Invalid branch name');
    if (name === req.repoEntry.defaultBranch) throw new HttpError(400, 'The default branch cannot be deleted');
    await github.deleteBranch(req.repoEntry.owner, req.repoEntry.repo, name);
    res.status(204).end();
  }));

  // ---- Flows ---------------------------------------------------------------
  const validateFlow = (body) => {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 100) throw new HttpError(400, 'Flow name is required (max 100 characters)');
    if (!Array.isArray(body.steps) || body.steps.length === 0 || body.steps.length > 20) {
      throw new HttpError(400, 'A flow needs between 1 and 20 steps');
    }
    const steps = body.steps.map((step, i) => {
      const s = step || {};
      assertRepoName(s.owner, s.repo);
      const entry = store.findRepo(s.owner, s.repo);
      if (!entry) throw new HttpError(400, `Step ${i + 1}: repository ${s.owner}/${s.repo} is not registered`);
      const workflow = String(s.workflow || '');
      if (!WORKFLOW_RE.test(workflow)) throw new HttpError(400, `Step ${i + 1}: invalid workflow`);
      const ref = s.ref || entry.defaultBranch;
      if (!isValidRefName(ref)) throw new HttpError(400, `Step ${i + 1}: invalid ref`);
      return { owner: entry.owner, repo: entry.repo, workflow, workflowName: s.workflowName || workflow, ref, inputs: parseInputs(s.inputs) };
    });
    return { name, steps };
  };

  api.get('/flows', (req, res) => {
    res.json(store.listFlows());
  });

  api.post('/flows', (req, res) => {
    res.status(201).json(store.addFlow(validateFlow(req.body || {})));
  });

  api.delete('/flows/:id', (req, res) => {
    if (!store.removeFlow(req.params.id)) throw new HttpError(404, 'Flow not found');
    res.status(204).end();
  });

  api.post('/flows/:id/run', (req, res) => {
    const flow = store.getFlow(req.params.id);
    if (!flow) throw new HttpError(404, 'Flow not found');
    res.status(202).json(flowRunner.start(flow));
  });

  api.get('/executions', (req, res) => {
    res.json(flowRunner.list());
  });

  api.get('/executions/:id', (req, res) => {
    const execution = flowRunner.get(req.params.id);
    if (!execution) throw new HttpError(404, 'Execution not found');
    res.json(execution);
  });

  api.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // eslint-disable-next-line no-unused-vars
  api.use((err, req, res, next) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
    } else if (err instanceof GitHubError) {
      const status = err.status >= 400 && err.status < 500 ? err.status : 502;
      res.status(status).json({ error: `GitHub: ${err.message}` });
    } else if (err && err.type === 'entity.parse.failed') {
      res.status(400).json({ error: 'Invalid JSON body' });
    } else {
      console.error(err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.use('/api', api);
  return app;
}

module.exports = { createApp, isValidRefName };
