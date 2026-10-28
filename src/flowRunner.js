'use strict';

const crypto = require('node:crypto');

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Executes flows: an ordered list of workflow dispatches across repositories.
 * Each step is triggered only after the previous step's run finished with
 * conclusion "success"; otherwise the flow stops and remaining steps are skipped.
 */
class FlowRunner {
  constructor({
    github,
    pollIntervalMs = 5000,
    discoverTimeoutMs = 2 * 60 * 1000,
    runTimeoutMs = 6 * 60 * 60 * 1000,
    maxExecutions = 50,
    sleep = defaultSleep,
    now = () => Date.now(),
  }) {
    this.github = github;
    this.pollIntervalMs = pollIntervalMs;
    this.discoverTimeoutMs = discoverTimeoutMs;
    this.runTimeoutMs = runTimeoutMs;
    this.maxExecutions = maxExecutions;
    this.sleep = sleep;
    this.now = now;
    this.executions = [];
  }

  list() {
    return this.executions;
  }

  get(id) {
    return this.executions.find((e) => e.id === id);
  }

  /** Starts the flow in the background and returns the execution record. */
  start(flow) {
    const execution = {
      id: crypto.randomUUID(),
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
    if (this.executions.length > this.maxExecutions) this.executions.length = this.maxExecutions;
    execution.done = this.execute(execution);
    Object.defineProperty(execution, 'done', { enumerable: false });
    return execution;
  }

  async execute(execution) {
    try {
      for (let i = 0; i < execution.steps.length; i += 1) {
        const step = execution.steps[i];
        await this.executeStep(step);
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
    }
  }

  async executeStep(step) {
    const { owner, repo, workflow, ref, inputs } = step;
    try {
      step.status = 'dispatching';
      const listOpts = { workflowId: workflow, event: 'workflow_dispatch', perPage: 20 };
      const before = await this.github.listRuns(owner, repo, listOpts);
      const knownIds = new Set(before.map((r) => r.id));
      const dispatchedAt = this.now();
      // GitHub reports head_branch as the short name, e.g. "main" for "refs/heads/main".
      const shortRef = ref ? String(ref).replace(/^refs\/(?:heads|tags)\//, '') : ref;

      await this.github.dispatchWorkflow(owner, repo, workflow, ref, inputs);
      step.status = 'queued';

      let run = null;
      while (!run) {
        if (this.now() - dispatchedAt > this.discoverTimeoutMs) {
          throw new Error('Timed out waiting for the dispatched workflow run to appear');
        }
        await this.sleep(this.pollIntervalMs);
        const runs = await this.github.listRuns(owner, repo, listOpts);
        const candidates = runs.filter((r) => !knownIds.has(r.id) && (!shortRef || !r.head_branch || r.head_branch === shortRef));
        // The oldest unseen run is the one created by our dispatch.
        run = candidates.sort((a, b) => new Date(a.created_at) - new Date(b.created_at))[0] || null;
      }
      step.runId = run.id;
      step.runUrl = run.html_url;
      step.status = run.status;

      while (run.status !== 'completed') {
        if (this.now() - dispatchedAt > this.runTimeoutMs) {
          throw new Error('Timed out waiting for the workflow run to complete');
        }
        await this.sleep(this.pollIntervalMs);
        run = await this.github.getRun(owner, repo, run.id);
        step.status = run.status;
      }
      step.status = 'completed';
      step.conclusion = run.conclusion;
    } catch (err) {
      step.status = 'completed';
      step.conclusion = 'error';
      step.error = err.message;
    }
  }
}

module.exports = { FlowRunner };
