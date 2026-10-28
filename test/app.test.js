'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp, isValidRefName } = require('../src/app');
const { Store } = require('../src/store');
const { GitHubError } = require('../src/github');

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

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpm-'));
  const store = new Store(path.join(dir, 'db.json'));
  const github = fakeGitHub();
  const started = [];
  const flowRunner = {
    start: (flow) => { const x = { id: 'x1', flowId: flow.id, status: 'running', steps: flow.steps }; started.push(x); return x; },
    list: () => started,
    get: (id) => started.find((x) => x.id === id),
  };
  const app = createApp({ github, store, flowRunner, allowedHosts: ['gpm.internal'] });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const baseUrl = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (method, url, body) => {
    const res = await fetch(baseUrl + url, {
      method,
      headers: { 'X-Requested-With': 'XMLHttpRequest', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  return { call, baseUrl, github, store, dir, close: () => server.close() };
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
  res = await ctx.call('GET', '/executions/x1');
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
  assert.equal(await status('gpm.internal:8080'), 200);
  assert.equal(await status(`localhost:${port}`), 200);
});

test('a dot-segment branch name cannot be used to delete the default branch', async (t) => {
  const ctx = await setup();
  t.after(ctx.close);
  await ctx.call('POST', '/repos', { fullName: 'octo/hello' });
  const res = await ctx.call('DELETE', `/repos/octo/hello/branches?name=${encodeURIComponent('./main')}`);
  assert.equal(res.status, 400);
  assert.ok(!ctx.github.calls.some((c) => c[0] === 'deleteBranch'));
});
