'use strict';

const crypto = require('node:crypto');

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Executes flows: an ordered list of workflow dispatches across repositories.
 * Each step is triggered only after the previous step's run finished with
 * conclusion "success"; otherwise the flow stops and remaining steps are skipped.
 *
 * Every execution belongs to the user who started it. The GitHub client for a
 * step is resolved from that user's (encrypted) token when the step starts, so
 * the plaintext token is never stored with the execution.
 */
class FlowRunner {
  constructor({
    githubForUser,
    store = null,
    pollIntervalMs = 5000,
    discoverTimeoutMs = 2 * 60 * 1000,
    runTimeoutMs = 6 * 60 * 60 * 1000,
    maxExecutionsPerUser = 50,
    sleep = defaultSleep,
    now = () => Date.now(),
  }) {
    this.githubForUser = githubForUser;
    this.store = store;
    this.pollIntervalMs = pollIntervalMs;
    this.discoverTimeoutMs = discoverTimeoutMs;
    this.runTimeoutMs = runTimeoutMs;
    this.maxExecutionsPerUser = maxExecutionsPerUser;
    this.sleep = sleep;
    this.now = now;
    this.executions = store ? store.loadExecutions() : [];
    // Executions that were running when the server stopped cannot be resumed reliably.
    let changed = false;
    for (const execution of this.executions) {
      if (execution.status === 'running') {
        execution.status = 'interrupted';
        execution.error = 'The server restarted while this flow was running';
        execution.finishedAt = execution.finishedAt || new Date(this.now()).toISOString();
        for (const step of execution.steps) {
          if (step.status !== 'completed' && step.status !== 'skipped') step.status = 'interrupted';
        }
        changed = true;
      }
    }
    if (changed) this.persist();
  }

  persist() {
    if (this.store) this.store.saveExecutions(this.executions);
  }

  list(ownerId) {
    return this.executions.filter((e) => e.ownerId === ownerId);
  }

  get(id, ownerId) {
    return this.executions.find((e) => e.id === id && e.ownerId === ownerId);
  }

  /** Starts the flow in the background on behalf of `ownerId` and returns the execution record. */
  start(flow, ownerId) {
    const execution = {
      id: crypto.randomUUID(),
      ownerId,
      flowId: flow.id,
      flowName: flow.name,
      status: 'running',
      startedAt: new Date(this.now()).toISOString(),
      finishedAt: null,
      error: null,
      steps: flow.steps.map((step) => ({
        owner: step.owner,
        repo: step.repo,
        workflow: step.workflow,
        workflowName: step.workflowName || step.workflow,
        ref: step.ref,
        inputs: step.inputs || {},
        status: 'pending',
        conclusion: null,
        runId: null,
        runUrl: null,
        error: null,
      })),
    };
    this.executions.unshift(execution);
    const mine = this.executions.filter((e) => e.ownerId === ownerId);
    if (mine.length > this.maxExecutionsPerUser) {
      const drop = new Set(mine.slice(this.maxExecutionsPerUser));
      this.executions = this.executions.filter((e) => !drop.has(e));
    }
    this.persist();
    Object.defineProperty(execution, 'done', { value: this.execute(execution), enumerable: false });
    return execution;
  }

  async execute(execution) {
    try {
      for (let i = 0; i < execution.steps.length; i += 1) {
        const step = execution.steps[i];
        await this.executeStep(step, execution.ownerId);
        if (step.conclusion !== 'success') {
          for (const rest of execution.steps.slice(i + 1)) rest.status = 'skipped';
          execution.status = 'failed';
          return execution;
        }
      }
      execution.status = 'success';
      return execution;
    } catch (err) {
      execution.status = 'failed';
      execution.error = err.message;
      return execution;
    } finally {
      execution.finishedAt = new Date(this.now()).toISOString();
      this.persist();
    }
  }

  setStatus(step, status) {
    if (step.status === status) return;
    step.status = status;
    this.persist();
  }

  async executeStep(step, ownerId) {
    const { owner, repo, workflow, ref, inputs } = step;
    try {
      this.setStatus(step, 'dispatching');
      const github = this.githubForUser(ownerId);
      const listOpts = { workflowId: workflow, event: 'workflow_dispatch', perPage: 20 };
      const before = await github.listRuns(owner, repo, listOpts);
      const knownIds = new Set(before.map((r) => r.id));
      const dispatchedAt = this.now();
      // GitHub reports head_branch as the short name, e.g. "main" for "refs/heads/main".
      const shortRef = ref ? String(ref).replace(/^refs\/(?:heads|tags)\//, '') : ref;

      await github.dispatchWorkflow(owner, repo, workflow, ref, inputs);
      this.setStatus(step, 'queued');

      let run = null;
      while (!run) {
        if (this.now() - dispatchedAt > this.discoverTimeoutMs) {
          throw new Error('Timed out waiting for the dispatched workflow run to appear');
        }
        await this.sleep(this.pollIntervalMs);
        const runs = await github.listRuns(owner, repo, listOpts);
        const candidates = runs.filter((r) => !knownIds.has(r.id) && (!shortRef || !r.head_branch || r.head_branch === shortRef));
        // The oldest unseen run is the one created by our dispatch.
        run = candidates.sort((a, b) => new Date(a.created_at) - new Date(b.created_at))[0] || null;
      }
      step.runId = run.id;
      step.runUrl = run.html_url;
      this.setStatus(step, run.status);

      while (run.status !== 'completed') {
        if (this.now() - dispatchedAt > this.runTimeoutMs) {
          throw new Error('Timed out waiting for the workflow run to complete');
        }
        await this.sleep(this.pollIntervalMs);
        run = await this.githubForUser(ownerId).getRun(owner, repo, run.id);
        this.setStatus(step, run.status);
      }
      step.conclusion = run.conclusion;
      this.setStatus(step, 'completed');
    } catch (err) {
      step.conclusion = 'error';
      step.error = err.message;
      this.setStatus(step, 'completed');
    }
  }
}

module.exports = { FlowRunner };
