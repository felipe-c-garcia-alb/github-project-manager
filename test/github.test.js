'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { GitHubClient, GitHubError, parseLastPage } = require('../src/github');

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

test('parseLastPage reads the last page from a Link header', () => {
  const link = '<https://api.github.com/repositories/1/branches?per_page=1&page=2>; rel="next", '
    + '<https://api.github.com/repositories/1/branches?per_page=1&page=42>; rel="last"';
  assert.equal(parseLastPage(link), 42);
  assert.equal(parseLastPage(null), null);
  assert.equal(parseLastPage('<https://x/?page=2>; rel="next"'), null);
});

test('getRepoSummary aggregates branches, tags, PRs and actions', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    const u = new URL(url);
    if (u.pathname.endsWith('/branches')) {
      return jsonResponse([{}], { headers: { link: '<https://api.github.com/x?per_page=1&page=7>; rel="last"' } });
    }
    if (u.pathname.endsWith('/tags')) return jsonResponse([{}]);
    if (u.pathname.endsWith('/pulls')) return jsonResponse([]);
    if (u.pathname.endsWith('/actions/workflows')) return jsonResponse({ total_count: 3, workflows: [] });
    if (u.pathname.endsWith('/actions/runs')) {
      return jsonResponse({ total_count: u.searchParams.get('status') ? 1 : 25, workflow_runs: [] });
    }
    return jsonResponse({ message: 'Not Found' }, { status: 404 });
  };
  const token = 'fake-token';
  const gh = new GitHubClient({ token, fetchImpl });
  const summary = await gh.getRepoSummary('octo', 'hello');
  assert.deepEqual(summary, {
    branches: 7,
    tags: 1,
    openPullRequests: 0,
    workflows: 3,
    workflowRuns: 25,
    runningWorkflowRuns: 1,
  });
  assert.equal(calls[0].opts.headers.Authorization, 'Bearer ' + token);
});

test('request throws GitHubError with status and message', async () => {
  const gh = new GitHubClient({ fetchImpl: async () => jsonResponse({ message: 'Bad credentials' }, { status: 401 }) });
  await assert.rejects(() => gh.getRepo('a', 'b'), (err) => err instanceof GitHubError && err.status === 401 && err.message === 'Bad credentials');
});

test('getJobLogs returns null when logs are not yet available', async () => {
  const gh = new GitHubClient({ fetchImpl: async () => jsonResponse({ message: 'Not Found' }, { status: 404 }) });
  assert.equal(await gh.getJobLogs('a', 'b', 1), null);
});

test('createBranch resolves the source sha and creates the ref', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, method: opts.method, body: opts.body });
    if (opts.method === 'GET') return jsonResponse({ object: { sha: 'abc123' } });
    return jsonResponse({ ref: 'refs/heads/feature/x' }, { status: 201 });
  };
  const gh = new GitHubClient({ fetchImpl });
  await gh.createBranch('o', 'r', 'feature/x', 'release/1.0');
  assert.equal(calls[0].url, 'https://api.github.com/repos/o/r/git/ref/heads/release/1.0');
  assert.equal(calls[1].url, 'https://api.github.com/repos/o/r/git/refs');
  assert.deepEqual(JSON.parse(calls[1].body), { ref: 'refs/heads/feature/x', sha: 'abc123' });
});

test('dispatchWorkflow posts ref and inputs', async () => {
  let captured;
  const gh = new GitHubClient({
    fetchImpl: async (url, opts) => {
      captured = { url, opts };
      return new Response(null, { status: 204 });
    },
  });
  const result = await gh.dispatchWorkflow('o', 'r', 'ci.yml', 'main', { env: 'prod' });
  assert.equal(result, null);
  assert.equal(captured.url, 'https://api.github.com/repos/o/r/actions/workflows/ci.yml/dispatches');
  assert.equal(captured.opts.method, 'POST');
  assert.deepEqual(JSON.parse(captured.opts.body), { ref: 'main', inputs: { env: 'prod' } });
});
