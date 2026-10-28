'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp, isValidRefName } = require('../src/app');
const { Store } = require('../src/store');
const crypto = require('node:crypto');
const { GitHubError } = require('../src/github');
const { SecretBox } = require('../src/crypto');
const { TokenService } = require('../src/tokens');

function fakeGitHub() {
  const calls = [];
  return {
    calls,
    async getRepo(owner, repo) {
      if (repo === 'missing') throw new GitHubError('Not Found', 404);
      return { owner: { login: owner }, name: repo, full_name: `${owner}/${repo}`, html_url: `https://github.com/${owner}/${repo}`, default_branch: 'main' };
    },
    async getRepoSummary() {
      return { branches: 2, tags: 1, openPullRequests: 3, workflows: 1, workflowRuns: 9, runningWorkflowRuns: 0 };
    },
    async listPullRequests(owner, repo, opts) {
      calls.push(['listPullRequests', opts]);
      return [{ number: 1, title: 'Fix', state: 'open', html_url: 'https://github.com/o/r/pull/1', user: { login: 'u' }, head: { ref: 'f' }, base: { ref: 'main' } }];
    },
    async listWorkflows() {
      return [{ id: 11, name: 'CI', path: '.github/workflows/ci.yml', state: 'active' }];
    },
    async listRuns() {
      return [{ id: 5, name: 'CI', status: 'in_progress', conclusion: null, head_branch: 'main' }];
    },
    async getRun(owner, repo, id) {
      return { id: Number(id), name: 'CI', status: 'in_progress' };
    },
    async listJobs() {
      return [{ id: 7, name: 'build', status: 'in_progress', steps: [{ number: 1, name: 'Checkout', status: 'completed', conclusion: 'success' }] }];
    },
    async getJobLogs() {
      return null;
    },
    async listBranches() {
      return [{ name: 'main', protected: true, commit: { sha: 'abc' } }, { name: 'dev', protected: false, commit: { sha: 'def' } }];
    },
    async createBranch(...args) {
      calls.push(['createBranch', ...args]);
    },
    async deleteBranch(...args) {
      calls.push(['deleteBranch', ...args]);
    },
    async dispatchWorkflow(...args) {
      calls.push(['dispatchWorkflow', ...args]);
    },
  };
}

const TOKEN_A = 'ghp_aliceAAAAAAAAAAAAAAAAAAAAAAAAAAAA1111';
const TOKEN_B = 'ghp_bobBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB2222';

async function setup({ appOptions = {}, signIn = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpm-'));
  const store = new Store(path.join(dir, 'db.json'));
  const github = fakeGitHub();
  const clientsFor = [];
  const tokens = new TokenService({
    store,
    secretBox: new SecretBox({ currentKey: crypto.randomBytes(32) }),
    createGitHub: (token) => {
      clientsFor.push(token);
      return {
        ...github,
        async getAuthenticatedUser() {
          if (token.startsWith('ghp_bad')) throw new GitHubError('Bad credentials', 401);
          return { login: `gh-${token.slice(4, 9)}` };
        },
      };
    },
  });
  const started = [];
  const flowRunner = {
    start: (flow, ownerId) => { const x = { id: `x${started.length + 1}`, flowId: flow.id, ownerId, status: 'running', steps: flow.steps }; started.push(x); return x; },
    list: (ownerId) => started.filter((x) => x.ownerId === ownerId),
    get: (id, ownerId) => started.find((x) => x.id === id && x.ownerId === ownerId),
  };
  const app = createApp({ store, tokens, flowRunner, allowedHosts: ['gpm.internal'], ...appOptions });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const baseUrl = `http://127.0.0.1:${server.address().port}/api`;

  // A tiny cookie-keeping client: fetch() does not store cookies by itself.
  const client = () => {
    let cookie = '';
    const call = async (method, url, body, headers = {}) => {
      const res = await fetch(baseUrl + url, {
        method,
        headers: {
          'X-Requested-With': 'XMLHttpRequest',
          ...(cookie ? { Cookie: cookie } : {}),
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...headers,
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers, raw: text };
    };
    return call;
  };

  const call = client();
  if (signIn) {
    assert.equal((await call('POST', '/auth/signup', { username: 'alice', password: 'correct horse battery' })).status, 201);
    assert.equal((await call('PUT', '/me/token', { token: TOKEN_A })).status, 200);
  }
  return { call, client, baseUrl, github, store, dir, clientsFor, close: () => server.close() };
}

test('isValidRefName accepts typical names and rejects unsafe ones', () => {
  for (const ok of ['main', 'feature/x', 'release-1.0', 'v1.2.3']) assert.ok(isValidRefName(ok), ok);
  for (const bad of ['', '../etc', 'a b', 'a..b', '/x', 'x/', 'a//b', 'x.lock', 'a~1', './main', 'a/./b', '.hidden', undefined, 5]) {
    assert.ok(!isValidRefName(bad), String(bad));
  }
});

test('repository registration, dashboard and removal', async (t) => {
  const ctx = await setup();
  t.after(ctx.close);

  let res = await ctx.call('POST', '/repos', { fullName: 'https://github.com/octo/hello.git/' });
  assert.equal(res.status, 201);
  assert.equal(res.body.fullName, 'octo/hello');
  assert.equal(res.body.defaultBranch, 'main');

  res = await ctx.call('POST', '/repos', { fullName: 'octo/missing' });
  assert.equal(res.status, 404);

  res = await ctx.call('POST', '/repos', { fullName: 'bad owner/x' });
  assert.equal(res.status, 400);

  res = await ctx.call('GET', '/dashboard');
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].summary.openPullRequests, 3);

  // persisted to disk
  const reloaded = new Store(path.join(ctx.dir, 'db.json'));
  assert.equal(reloaded.listRepos().length, 1);

  res = await ctx.call('DELETE', '/repos/octo/hello');
  assert.equal(res.status, 204);
  res = await ctx.call('GET', '/repos');
  assert.deepEqual(res.body, []);
});

test('repo endpoints require a registered repository', async (t) => {
  const ctx = await setup();
  t.after(ctx.close);
  const res = await ctx.call('GET', '/repos/someone/else/pulls');
  assert.equal(res.status, 404);
});

test('pull requests, actions, logs and branches of a registered repo', async (t) => {
  const ctx = await setup();
  t.after(ctx.close);
  await ctx.call('POST', '/repos', { fullName: 'octo/hello' });

  let res = await ctx.call('GET', '/repos/octo/hello/pulls?state=all');
  assert.equal(res.status, 200);
  assert.equal(res.body[0].htmlUrl, 'https://github.com/o/r/pull/1');
  assert.deepEqual(ctx.github.calls.at(-1), ['listPullRequests', { state: 'all' }]);

  res = await ctx.call('GET', '/repos/octo/hello/runs');
  assert.equal(res.body[0].status, 'in_progress');

  res = await ctx.call('GET', '/repos/octo/hello/runs/5/jobs');
  assert.equal(res.body[0].steps[0].name, 'Checkout');

  res = await ctx.call('GET', '/repos/octo/hello/runs/abc/jobs');
  assert.equal(res.status, 400);

  res = await ctx.call('GET', '/repos/octo/hello/jobs/7/logs');
  assert.deepEqual(res.body, { available: false, logs: '' });

  res = await ctx.call('GET', '/repos/octo/hello/branches');
  assert.deepEqual(res.body.map((b) => [b.name, b.isDefault, b.protected]), [['main', true, true], ['dev', false, false]]);

  res = await ctx.call('POST', '/repos/octo/hello/branches', { name: 'feature/new' });
  assert.equal(res.status, 201);
  assert.deepEqual(ctx.github.calls.at(-1), ['createBranch', 'octo', 'hello', 'feature/new', 'main']);

  res = await ctx.call('POST', '/repos/octo/hello/branches', { name: 'bad..name' });
  assert.equal(res.status, 400);

  res = await ctx.call('DELETE', '/repos/octo/hello/branches?name=main');
  assert.equal(res.status, 400);

  res = await ctx.call('DELETE', `/repos/octo/hello/branches?name=${encodeURIComponent('feature/new')}`);
  assert.equal(res.status, 204);
  assert.deepEqual(ctx.github.calls.at(-1), ['deleteBranch', 'octo', 'hello', 'feature/new']);
});

test('workflow dispatch', async (t) => {
  const ctx = await setup();
  t.after(ctx.close);
  await ctx.call('POST', '/repos', { fullName: 'octo/hello' });

  let res = await ctx.call('POST', '/repos/octo/hello/workflows/11/dispatches', { inputs: { env: 'prod', n: 2 } });
  assert.equal(res.status, 202);
  assert.deepEqual(ctx.github.calls.at(-1), ['dispatchWorkflow', 'octo', 'hello', '11', 'main', { env: 'prod', n: '2' }]);

  res = await ctx.call('POST', '/repos/octo/hello/workflows/11/dispatches', { inputs: [1] });
  assert.equal(res.status, 400);
});

test('flows can be created, run and deleted', async (t) => {
  const ctx = await setup();
  t.after(ctx.close);
  await ctx.call('POST', '/repos', { fullName: 'acme/api' });
  await ctx.call('POST', '/repos', { fullName: 'acme/web' });

  let res = await ctx.call('POST', '/flows', {
    name: 'Build then deploy',
    steps: [
      { owner: 'acme', repo: 'api', workflow: 'build.yml' },
      { owner: 'acme', repo: 'web', workflow: '42', ref: 'release', inputs: { env: 'prod' } },
    ],
  });
  assert.equal(res.status, 201);
  const flow = res.body;
  assert.equal(flow.steps[0].ref, 'main');
  assert.equal(flow.steps[1].ref, 'release');

  res = await ctx.call('POST', '/flows', { name: 'x', steps: [{ owner: 'acme', repo: 'unknown', workflow: 'a.yml' }] });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /not registered/);

  res = await ctx.call('POST', '/flows', { name: 'x', steps: [] });
  assert.equal(res.status, 400);

  res = await ctx.call('POST', `/flows/${flow.id}/run`);
  assert.equal(res.status, 202);
  assert.equal(res.body.flowId, flow.id);

  res = await ctx.call('GET', '/executions');
  assert.equal(res.body.length, 1);
  res = await ctx.call('GET', `/executions/${res.body[0].id}`);
  assert.equal(res.status, 200);

  res = await ctx.call('DELETE', `/flows/${flow.id}`);
  assert.equal(res.status, 204);
  res = await ctx.call('POST', `/flows/${flow.id}/run`);
  assert.equal(res.status, 404);
});

test('invalid JSON bodies are rejected with 400', async (t) => {
  const ctx = await setup();
  t.after(ctx.close);
  const res = await fetch(`${ctx.baseUrl}/flows`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
    body: '{not json',
  });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'Invalid JSON body' });
});

test('mutating requests without X-Requested-With are rejected (CSRF)', async (t) => {
  const ctx = await setup();
  t.after(ctx.close);
  await ctx.call('POST', '/repos', { fullName: 'octo/hello' });
  const res = await fetch(`${ctx.baseUrl}/repos/octo/hello/workflows/deploy.yml/dispatches`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'x=1',
  });
  assert.equal(res.status, 403);
  assert.ok(!ctx.github.calls.some((c) => c[0] === 'dispatchWorkflow'));
});

test('requests with an unexpected Host header are rejected (DNS rebinding)', async (t) => {
  const ctx = await setup();
  t.after(ctx.close);
  const http = require('node:http');
  const { port } = new URL(ctx.baseUrl);
  const status = (host) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/api/repos', headers: { Host: host } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    }).on('error', reject);
  });
  assert.equal(await status('evil.example.com'), 403);
  // Allowed hosts pass the guard and then hit the sign-in check.
  assert.equal(await status('gpm.internal:8080'), 401);
  assert.equal(await status(`localhost:${port}`), 401);
});

test('a dot-segment branch name cannot be used to delete the default branch', async (t) => {
  const ctx = await setup();
  t.after(ctx.close);
  await ctx.call('POST', '/repos', { fullName: 'octo/hello' });
  const res = await ctx.call('DELETE', `/repos/octo/hello/branches?name=${encodeURIComponent('./main')}`);
  assert.equal(res.status, 400);
  assert.ok(!ctx.github.calls.some((c) => c[0] === 'deleteBranch'));
});

test('API requires a session; first user can sign up, later sign-ups are closed', async (t) => {
  const ctx = await setup({ signIn: false });
  t.after(ctx.close);
  const anon = ctx.client();
  assert.equal((await anon('GET', '/repos')).status, 401);
  assert.equal((await anon('GET', '/health')).status, 200);
  assert.deepEqual((await anon('GET', '/auth/status')).body, { setupRequired: true, signupOpen: true, user: null });

  assert.equal((await anon('POST', '/auth/signup', { username: 'x', password: 'correct horse battery' })).status, 400);
  assert.equal((await anon('POST', '/auth/signup', { username: 'alice', password: 'short' })).status, 400);

  const res = await anon('POST', '/auth/signup', { username: 'alice', password: 'correct horse battery' });
  assert.equal(res.status, 201);
  const cookie = res.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.equal((await anon('GET', '/repos')).status, 200);

  const other = ctx.client();
  assert.equal((await other('GET', '/auth/status')).body.signupOpen, false);
  assert.equal((await other('POST', '/auth/signup', { username: 'mallory', password: 'correct horse battery' })).status, 403);
  assert.equal((await other('POST', '/auth/login', { username: 'alice', password: 'wrong password!' })).status, 401);
  assert.equal((await other('POST', '/auth/login', { username: 'nobody', password: 'wrong password!' })).status, 401);
  assert.equal((await other('POST', '/auth/login', { username: 'ALICE', password: 'correct horse battery' })).status, 200);
  assert.equal((await other('GET', '/me')).body.username, 'alice');

  assert.equal((await other('POST', '/auth/logout')).status, 204);
  assert.equal((await other('GET', '/me')).status, 401);
});

test('GitHub token is validated, stored encrypted and never returned', async (t) => {
  const ctx = await setup({ signIn: false });
  t.after(ctx.close);
  const call = ctx.client();
  await call('POST', '/auth/signup', { username: 'alice', password: 'correct horse battery' });

  let res = await call('GET', '/me');
  assert.deepEqual(res.body.githubToken, { set: false });
  await call('POST', '/repos', { fullName: 'octo/hello' });
  res = await call('GET', '/dashboard');
  assert.equal(res.status, 412);

  assert.equal((await call('PUT', '/me/token', { token: 'not a token' })).status, 400);
  res = await call('PUT', '/me/token', { token: 'ghp_badXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX' });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'GitHub rejected this token');
  assert.ok(!res.raw.includes('ghp_bad'));

  res = await call('PUT', '/me/token', { token: TOKEN_A });
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.body).sort(), ['githubLogin', 'last4', 'set', 'updatedAt']);
  assert.equal(res.body.last4, '1111');

  const raw = fs.readFileSync(path.join(ctx.dir, 'db.json'), 'utf8');
  assert.ok(!raw.includes(TOKEN_A), 'token must not be stored in plaintext');
  assert.ok(!raw.includes('correct horse battery'), 'password must not be stored in plaintext');
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(path.join(ctx.dir, 'db.json')).mode & 0o777, 0o600);
  }

  for (const url of ['/me', '/auth/status', '/repos', '/dashboard', '/flows', '/executions']) {
    res = await call('GET', url);
    assert.ok(!res.raw.includes(TOKEN_A), `${url} leaked the token`);
    assert.ok(!res.raw.includes('passwordHash'), `${url} leaked the password hash`);
  }
  assert.equal(ctx.clientsFor.at(-1), TOKEN_A);

  assert.equal((await call('DELETE', '/me/token')).status, 204);
  assert.deepEqual((await call('GET', '/me')).body.githubToken, { set: false });
});

test('each user gets their own GitHub client, flows and executions', async (t) => {
  const ctx = await setup({ appOptions: { allowSignup: true } });
  t.after(ctx.close);
  await ctx.call('POST', '/repos', { fullName: 'acme/api' });
  const flow = (await ctx.call('POST', '/flows', { name: 'A', steps: [{ owner: 'acme', repo: 'api', workflow: 'b.yml' }] })).body;
  const execution = (await ctx.call('POST', `/flows/${flow.id}/run`)).body;

  const bob = ctx.client();
  assert.equal((await bob('POST', '/auth/signup', { username: 'bob', password: 'another long password' })).status, 201);
  assert.equal((await bob('PUT', '/me/token', { token: TOKEN_B })).status, 200);

  // Repositories are shared; flows and executions are private.
  assert.equal((await bob('GET', '/repos')).body.length, 1);
  assert.deepEqual((await bob('GET', '/flows')).body, []);
  assert.deepEqual((await bob('GET', '/executions')).body, []);
  assert.equal((await bob('GET', `/executions/${execution.id}`)).status, 404);
  assert.equal((await bob('POST', `/flows/${flow.id}/run`)).status, 404);
  assert.equal((await bob('DELETE', `/flows/${flow.id}`)).status, 404);

  await bob('GET', '/dashboard');
  assert.equal(ctx.clientsFor.at(-1), TOKEN_B);
  await ctx.call('GET', '/dashboard');
  assert.equal(ctx.clientsFor.at(-1), TOKEN_A);
  assert.equal((await ctx.call('GET', '/flows')).body.length, 1);
});

test('REQUIRE_HTTPS rejects plain HTTP and sends HSTS over HTTPS', async (t) => {
  const ctx = await setup({ signIn: false, appOptions: { allowLoopbackHttp: false, trustProxy: 'loopback' } });
  t.after(ctx.close);
  const call = ctx.client();
  let res = await call('POST', '/auth/signup', { username: 'alice', password: 'correct horse battery' });
  assert.equal(res.status, 403);
  assert.match(res.body.error, /HTTPS/);
  assert.equal((await call('GET', '/health')).status, 200);

  res = await call('POST', '/auth/signup', { username: 'alice', password: 'correct horse battery' }, { 'X-Forwarded-Proto': 'https' });
  assert.equal(res.status, 201);
  assert.match(res.headers.get('strict-transport-security'), /max-age=/);
  assert.match(res.headers.get('set-cookie'), /; Secure/);
});

test('forwarded requests are not treated as local when HTTPS is required', async (t) => {
  // Without a trusted proxy, X-Forwarded-* means the request came through something we do not trust.
  const ctx = await setup({ signIn: false });
  t.after(ctx.close);
  const call = ctx.client();
  const res = await call('GET', '/auth/status', null, { 'X-Forwarded-For': '203.0.113.9' });
  assert.equal(res.status, 403);
  assert.equal((await call('GET', '/auth/status')).status, 200);
});

test('login attempts are rate limited', async (t) => {
  // The setup's sign-up uses one of the four attempts.
  const ctx = await setup({ appOptions: { authRateLimitOptions: { windowMs: 60000, max: 4 } } });
  t.after(ctx.close);
  const call = ctx.client();
  const statuses = [];
  for (let i = 0; i < 4; i += 1) {
    statuses.push((await call('POST', '/auth/login', { username: 'alice', password: 'wrong password!' })).status);
  }
  assert.deepEqual(statuses, [401, 401, 401, 429]);
});
