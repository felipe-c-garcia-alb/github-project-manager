'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FlowRunner } = require('../src/flowRunner');
const { Store } = require('../src/store');

/** Fake GitHub that creates a run on each dispatch and completes it after `pollsToComplete` polls. */
function fakeGitHub(conclusions) {
  const runs = { };
  let nextId = 100;
  const dispatched = [];
  return {
    dispatched,
    async listRuns(owner, repo) {
      return (runs[`${owner}/${repo}`] || []).map((r) => ({ ...r }));
    },
    async dispatchWorkflow(owner, repo, workflow, ref, inputs) {
      dispatched.push({ owner, repo, workflow, ref, inputs });
      const key = `${owner}/${repo}`;
      runs[key] = runs[key] || [];
      runs[key].unshift({
        id: nextId += 1,
        status: 'queued',
        conclusion: null,
        head_branch: ref,
        created_at: new Date().toISOString(),
        html_url: `https://github.com/${key}/actions/runs/${nextId}`,
        polls: 0,
        finalConclusion: conclusions[`${key}:${workflow}`] || 'success',
      });
    },
    async getRun(owner, repo, id) {
      const run = runs[`${owner}/${repo}`].find((r) => r.id === id);
      run.polls += 1;
      if (run.polls === 1) run.status = 'in_progress';
      if (run.polls >= 2) {
        run.status = 'completed';
        run.conclusion = run.finalConclusion;
      }
      return { ...run };
    },
  };
}

const flow = {
  id: 'f1',
  name: 'build then deploy',
  steps: [
    { owner: 'acme', repo: 'api', workflow: 'build.yml', ref: 'main', inputs: {} },
    { owner: 'acme', repo: 'web', workflow: 'deploy.yml', workflowName: 'Deploy', ref: 'main', inputs: { env: 'prod' } },
  ],
};

test('runs the next step only after the previous one succeeds', async () => {
  const github = fakeGitHub({});
  const runner = new FlowRunner({ githubForUser: () => github, sleep: async () => {} });
  const execution = runner.start(flow, 'u1');
  assert.equal(execution.status, 'running');
  await execution.done;
  assert.equal(execution.status, 'success');
  assert.deepEqual(github.dispatched.map((d) => `${d.owner}/${d.repo}:${d.workflow}`), ['acme/api:build.yml', 'acme/web:deploy.yml']);
  assert.deepEqual(github.dispatched[1].inputs, { env: 'prod' });
  assert.ok(execution.steps.every((s) => s.conclusion === 'success' && s.runId));
  assert.ok(execution.finishedAt);
  assert.deepEqual(execution.steps.map((s) => s.workflowName), ['build.yml', 'Deploy']);
  assert.equal(runner.get(execution.id, 'u1'), execution);
});

test('stops the flow and skips remaining steps when a step fails', async () => {
  const github = fakeGitHub({ 'acme/api:build.yml': 'failure' });
  const runner = new FlowRunner({ githubForUser: () => github, sleep: async () => {} });
  const execution = runner.start(flow, 'u1');
  await execution.done;
  assert.equal(execution.status, 'failed');
  assert.equal(execution.steps[0].conclusion, 'failure');
  assert.equal(execution.steps[1].status, 'skipped');
  assert.equal(github.dispatched.length, 1);
});

test('marks the step as errored when the dispatched run never appears', async () => {
  let clock = 0;
  const github = {
    listRuns: async () => [],
    dispatchWorkflow: async () => {},
    getRun: async () => { throw new Error('unexpected'); },
  };
  const runner = new FlowRunner({
    githubForUser: () => github,
    discoverTimeoutMs: 1000,
    pollIntervalMs: 400,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
  });
  const execution = runner.start(flow, 'u1');
  await execution.done;
  assert.equal(execution.status, 'failed');
  assert.equal(execution.steps[0].conclusion, 'error');
  assert.match(execution.steps[0].error, /Timed out/);
  assert.equal(execution.steps[1].status, 'skipped');
});

test('executions are serialisable to JSON', async () => {
  const runner = new FlowRunner({ githubForUser: () => fakeGitHub({}), sleep: async () => {} });
  const execution = runner.start(flow, 'u1');
  await execution.done;
  const json = JSON.parse(JSON.stringify(runner.list('u1')));
  assert.equal(json[0].flowName, 'build then deploy');
  assert.equal(json[0].done, undefined);
});

test('matches the dispatched run when the step uses a full ref name', async () => {
  const github = fakeGitHub({});
  const realDispatch = github.dispatchWorkflow;
  // GitHub reports head_branch as the short branch name.
  github.dispatchWorkflow = (owner, repo, workflow, ref, inputs) => realDispatch(owner, repo, workflow, ref.replace('refs/heads/', ''), inputs);
  const runner = new FlowRunner({ githubForUser: () => github, sleep: async () => {} });
  const execution = runner.start({ id: 'f2', name: 'full ref', steps: [{ owner: 'acme', repo: 'api', workflow: 'build.yml', ref: 'refs/heads/main' }] }, 'u1');
  await execution.done;
  assert.equal(execution.status, 'success');
});

test('uses the flow owner\'s GitHub client and keeps executions private', async () => {
  const clients = { u1: fakeGitHub({}), u2: fakeGitHub({}) };
  const asked = [];
  const runner = new FlowRunner({ githubForUser: (id) => { asked.push(id); return clients[id]; }, sleep: async () => {} });
  const execution = runner.start(flow, 'u2');
  await execution.done;
  assert.ok(asked.length > 0 && asked.every((id) => id === 'u2'));
  assert.equal(clients.u1.dispatched.length, 0);
  assert.equal(clients.u2.dispatched.length, 2);
  assert.deepEqual(runner.list('u1'), []);
  assert.equal(runner.get(execution.id, 'u1'), undefined);
});

test('a step errors cleanly when the owner has no token', async () => {
  const runner = new FlowRunner({ githubForUser: () => { throw new Error('No GitHub token configured'); }, sleep: async () => {} });
  const execution = runner.start(flow, 'u1');
  await execution.done;
  assert.equal(execution.status, 'failed');
  assert.match(execution.steps[0].error, /No GitHub token/);
});

test('executions are saved to the store and running ones become interrupted after a restart', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gpm-')), 'db.json');
  const store = new Store(file);
  const github = fakeGitHub({});
  const runner = new FlowRunner({ githubForUser: () => github, store, sleep: async () => {} });
  const execution = runner.start(flow, 'u1');
  await execution.done;

  // Simulate a server stopping while a flow is mid-run.
  const pending = new FlowRunner({ githubForUser: () => github, store, sleep: () => new Promise(() => {}) });
  pending.start(flow, 'u1');

  const restarted = new FlowRunner({ githubForUser: () => fakeGitHub({}), store: new Store(file) });
  const statuses = restarted.list('u1').map((e) => e.status).sort();
  assert.deepEqual(statuses, ['interrupted', 'success']);
  const interrupted = restarted.list('u1').find((e) => e.status === 'interrupted');
  assert.ok(interrupted.finishedAt);
  assert.equal(new Store(file).loadExecutions().find((e) => e.id === interrupted.id).status, 'interrupted');
});
