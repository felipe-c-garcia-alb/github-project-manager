'use strict';

const path = require('node:path');
const express = require('express');
const { GitHubError } = require('./github');
const { hashPassword, verifyPassword } = require('./crypto');
const { TokenService, NoTokenError, InvalidTokenError } = require('./tokens');
const { SessionStore } = require('./sessions');

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;
const WORKFLOW_RE = /^[A-Za-z0-9._-]{1,255}$/;
const NUMERIC_RE = /^\d{1,20}$/;
const USERNAME_RE = /^[A-Za-z0-9_.-]{3,40}$/;
const SESSION_COOKIE = 'gpm_session';

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

function isLoopback(req) {
  const addr = req.socket.remoteAddress || '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  }
  return out;
}

function createApp({
  store,
  tokens,
  flowRunner,
  sessions = new SessionStore(),
  rateLimitOptions,
  authRateLimitOptions = { windowMs: 15 * 60 * 1000, max: 20 },
  allowedHosts,
  allowSignup = false,
  requireHttps = true,
  allowLoopbackHttp = true,
  trustProxy = false,
} = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', trustProxy);

  // Tell browsers to only ever use HTTPS once they reached us over HTTPS.
  app.use((req, res, next) => {
    if (req.secure) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
  });
  app.use(express.static(path.join(__dirname, '..', 'public')));

  const api = express.Router();
  // Unauthenticated liveness probe used by the Docker health check.
  api.get('/health', (req, res) => {
    res.set('Cache-Control', 'no-store').json({ status: 'ok' });
  });
  api.use(rateLimit(rateLimitOptions));
  api.use(requestGuard({ allowedHosts }));
  // Passwords, session cookies and GitHub tokens must never travel unencrypted.
  // Plain HTTP is only accepted from the local machine (development), unless disabled.
  api.use((req, res, next) => {
    const direct = !req.get('X-Forwarded-For') && !req.get('X-Forwarded-Proto') && !req.get('Forwarded');
    if (!requireHttps || req.secure || (allowLoopbackHttp && direct && isLoopback(req))) {
      next();
      return;
    }
    res.status(403).json({ error: 'HTTPS is required' });
  });
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

  // ---- Authentication --------------------------------------------------------
  const setSessionCookie = (req, res, id, maxAgeMs) => {
    const attrs = [`${SESSION_COOKIE}=${id}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${Math.floor(maxAgeMs / 1000)}`];
    if (req.secure) attrs.push('Secure');
    res.append('Set-Cookie', attrs.join('; '));
  };

  const startSession = (req, res, user) => {
    setSessionCookie(req, res, sessions.create(user.id), sessions.ttlMs);
  };

  const currentUser = (req) => {
    const userId = sessions.get(parseCookies(req.get('Cookie'))[SESSION_COOKIE]);
    return userId ? store.getUser(userId) : null;
  };

  const signupOpen = () => store.countUsers() === 0 || allowSignup;
  const authLimiter = rateLimit(authRateLimitOptions);

  const readCredentials = (body) => {
    const { username, password } = body || {};
    if (typeof username !== 'string' || typeof password !== 'string') throw new HttpError(400, 'Username and password are required');
    return { username: username.trim(), password };
  };

  api.get('/auth/status', (req, res) => {
    const user = currentUser(req);
    res.json({ setupRequired: store.countUsers() === 0, signupOpen: signupOpen(), user: user ? { username: user.username } : null });
  });

  api.post('/auth/signup', authLimiter, (req, res) => {
    if (!signupOpen()) throw new HttpError(403, 'Sign-up is disabled. Ask an administrator to enable ALLOW_SIGNUP.');
    const { username, password } = readCredentials(req.body);
    if (!USERNAME_RE.test(username)) throw new HttpError(400, 'Username must be 3-40 characters: letters, digits, ".", "_" or "-"');
    if (password.length < 10 || password.length > 200) throw new HttpError(400, 'Password must be between 10 and 200 characters');
    if (store.findUserByName(username)) throw new HttpError(409, 'That username is taken');
    const user = store.addUser({ username, passwordHash: hashPassword(password) });
    startSession(req, res, user);
    res.status(201).json({ username: user.username });
  });

  api.post('/auth/login', authLimiter, (req, res) => {
    const { username, password } = readCredentials(req.body);
    const user = store.findUserByName(username);
    const ok = verifyPassword(password.slice(0, 200), user && user.passwordHash);
    if (!user || !ok) throw new HttpError(401, 'Invalid username or password');
    startSession(req, res, user);
    res.json({ username: user.username });
  });

  api.post('/auth/logout', (req, res) => {
    sessions.destroy(parseCookies(req.get('Cookie'))[SESSION_COOKIE]);
    setSessionCookie(req, res, '', 0);
    res.status(204).end();
  });

  // Everything below requires a signed-in user.
  api.use((req, res, next) => {
    const user = currentUser(req);
    if (!user) {
      res.status(401).json({ error: 'Sign in required' });
      return;
    }
    req.user = user;
    // GitHub client authenticated with the signed-in user's own token, built on first use.
    let client;
    Object.defineProperty(req, 'github', {
      get() {
        if (!client) client = tokens.githubFor(user.id);
        return client;
      },
    });
    next();
  });

  // Only registered repositories can be accessed through the API so the
  // app cannot be used as an open proxy to arbitrary repositories.
  const registered = (req, res, next) => {
    const { owner, repo } = req.params;
    assertRepoName(owner, repo);
    const entry = store.findRepo(owner, repo);
    if (!entry) throw new HttpError(404, 'Repository is not registered');
    req.repoEntry = entry;
    next();
  };

  // ---- Current user & GitHub token -----------------------------------------
  api.get('/me', (req, res) => {
    res.json({ username: req.user.username, githubToken: TokenService.describe(req.user) });
  });

  api.put('/me/token', wrap(async (req, res) => {
    const { token } = req.body || {};
    res.json(await tokens.set(req.user.id, token));
  }));

  api.delete('/me/token', (req, res) => {
    tokens.clear(req.user.id);
    res.status(204).end();
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
    const info = await req.github.getRepo(owner, repo);
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
    const { github } = req;
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
    res.json(await req.github.getRepoSummary(req.repoEntry.owner, req.repoEntry.repo));
  }));

  // ---- Pull requests -------------------------------------------------------
  api.get('/repos/:owner/:repo/pulls', registered, wrap(async (req, res) => {
    const state = ['open', 'closed', 'all'].includes(req.query.state) ? req.query.state : 'open';
    const pulls = await req.github.listPullRequests(req.repoEntry.owner, req.repoEntry.repo, { state });
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
    const workflows = await req.github.listWorkflows(req.repoEntry.owner, req.repoEntry.repo);
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
    const runs = await req.github.listRuns(req.repoEntry.owner, req.repoEntry.repo, { perPage: 30 });
    res.json(runs.map(mapRun));
  }));

  api.get('/repos/:owner/:repo/runs/:runId', registered, wrap(async (req, res) => {
    if (!NUMERIC_RE.test(req.params.runId)) throw new HttpError(400, 'Invalid run id');
    res.json(mapRun(await req.github.getRun(req.repoEntry.owner, req.repoEntry.repo, req.params.runId)));
  }));

  api.get('/repos/:owner/:repo/runs/:runId/jobs', registered, wrap(async (req, res) => {
    if (!NUMERIC_RE.test(req.params.runId)) throw new HttpError(400, 'Invalid run id');
    const jobs = await req.github.listJobs(req.repoEntry.owner, req.repoEntry.repo, req.params.runId);
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
    const logs = await req.github.getJobLogs(req.repoEntry.owner, req.repoEntry.repo, req.params.jobId);
    res.json({ available: logs !== null, logs: logs || '' });
  }));

  api.post('/repos/:owner/:repo/workflows/:workflowId/dispatches', registered, wrap(async (req, res) => {
    const { workflowId } = req.params;
    if (!WORKFLOW_RE.test(workflowId)) throw new HttpError(400, 'Invalid workflow id');
    const body = req.body || {};
    const ref = body.ref || req.repoEntry.defaultBranch;
    if (!isValidRefName(ref)) throw new HttpError(400, 'Invalid ref');
    await req.github.dispatchWorkflow(req.repoEntry.owner, req.repoEntry.repo, workflowId, ref, parseInputs(body.inputs));
    res.status(202).json({ dispatched: true, ref });
  }));

  // ---- Branches ------------------------------------------------------------
  api.get('/repos/:owner/:repo/branches', registered, wrap(async (req, res) => {
    const branches = await req.github.listBranches(req.repoEntry.owner, req.repoEntry.repo);
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
    await req.github.createBranch(req.repoEntry.owner, req.repoEntry.repo, name, from);
    res.status(201).json({ name, from });
  }));

  api.delete('/repos/:owner/:repo/branches', registered, wrap(async (req, res) => {
    const { name } = req.query;
    if (!isValidRefName(name)) throw new HttpError(400, 'Invalid branch name');
    if (name === req.repoEntry.defaultBranch) throw new HttpError(400, 'The default branch cannot be deleted');
    await req.github.deleteBranch(req.repoEntry.owner, req.repoEntry.repo, name);
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
    res.json(store.listFlows(req.user.id));
  });

  api.post('/flows', (req, res) => {
    res.status(201).json(store.addFlow({ ...validateFlow(req.body || {}), ownerId: req.user.id }));
  });

  api.delete('/flows/:id', (req, res) => {
    if (!store.removeFlow(req.params.id, req.user.id)) throw new HttpError(404, 'Flow not found');
    res.status(204).end();
  });

  api.post('/flows/:id/run', (req, res) => {
    const flow = store.getFlow(req.params.id, req.user.id);
    if (!flow) throw new HttpError(404, 'Flow not found');
    res.status(202).json(flowRunner.start(flow, req.user.id));
  });

  api.get('/executions', (req, res) => {
    res.json(flowRunner.list(req.user.id));
  });

  api.get('/executions/:id', (req, res) => {
    const execution = flowRunner.get(req.params.id, req.user.id);
    if (!execution) throw new HttpError(404, 'Execution not found');
    res.json(execution);
  });

  api.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // eslint-disable-next-line no-unused-vars
  api.use((err, req, res, next) => {
    if (err instanceof HttpError || err instanceof NoTokenError || err instanceof InvalidTokenError) {
      res.status(err.status).json({ error: err.message });
    } else if (err instanceof GitHubError && err.status === 401) {
      // The user's own token was rejected; 401 is reserved for "not signed in to this app".
      res.status(412).json({ error: 'GitHub rejected your token. Update it on the Settings page.' });
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
