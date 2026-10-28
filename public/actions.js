'use strict';

renderNav('actions');

const messageEl = document.getElementById('message');
const preselected = new URLSearchParams(location.search).get('repo');
let repos = [];
const workflowCache = new Map();

async function getWorkflows(fullName) {
  if (!workflowCache.has(fullName)) {
    const [owner, repo] = fullName.split('/');
    workflowCache.set(fullName, api(`${repoApiPath(owner, repo)}/workflows`).catch((err) => {
      workflowCache.delete(fullName);
      throw err;
    }));
  }
  return workflowCache.get(fullName);
}

/** Builds the repo/workflow/ref/inputs fields inside container. */
function buildStepFields(container, initialRepo) {
  container.appendChild(document.getElementById('step-template').content.cloneNode(true));
  const repoSel = container.querySelector('.step-repo');
  const wfSel = container.querySelector('.step-workflow');
  const refInput = container.querySelector('.step-ref');
  repoSel.innerHTML = repos
    .map((r) => `<option value="${escapeHtml(r.fullName)}">${escapeHtml(r.fullName)}</option>`)
    .join('');
  if (initialRepo && repos.some((r) => r.fullName.toLowerCase() === initialRepo.toLowerCase())) {
    repoSel.value = repos.find((r) => r.fullName.toLowerCase() === initialRepo.toLowerCase()).fullName;
  }
  const loadWorkflows = async () => {
    const entry = repos.find((r) => r.fullName === repoSel.value);
    refInput.placeholder = entry ? entry.defaultBranch : 'default branch';
    wfSel.innerHTML = '<option value="">Loading…</option>';
    if (!entry) {
      wfSel.innerHTML = '<option value="">No repository</option>';
      return;
    }
    try {
      const workflows = await getWorkflows(entry.fullName);
      wfSel.innerHTML = workflows.length
        ? workflows.map((w) => `<option value="${w.id}">${escapeHtml(w.name)} (${escapeHtml(w.path)})</option>`).join('')
        : '<option value="">No workflows</option>';
    } catch (err) {
      wfSel.innerHTML = `<option value="">${escapeHtml(err.message)}</option>`;
    }
  };
  repoSel.addEventListener('change', loadWorkflows);
  loadWorkflows();
}

function readStepFields(container) {
  const entry = repos.find((r) => r.fullName === container.querySelector('.step-repo').value);
  if (!entry) throw new Error('Select a repository');
  const wfSel = container.querySelector('.step-workflow');
  if (!wfSel.value) throw new Error(`Select a workflow for ${entry.fullName}`);
  const rawInputs = container.querySelector('.step-inputs').value.trim();
  let inputs = {};
  if (rawInputs) {
    try {
      inputs = JSON.parse(rawInputs);
    } catch {
      throw new Error('Inputs must be valid JSON');
    }
  }
  return {
    owner: entry.owner,
    repo: entry.repo,
    workflow: wfSel.value,
    workflowName: wfSel.options[wfSel.selectedIndex].textContent,
    ref: container.querySelector('.step-ref').value.trim() || entry.defaultBranch,
    inputs,
  };
}

// ---- Single trigger --------------------------------------------------------
const triggerFields = document.querySelector('#trigger-form .step-fields');

document.getElementById('trigger-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const step = readStepFields(triggerFields);
    await api(`${repoApiPath(step.owner, step.repo)}/workflows/${encodeURIComponent(step.workflow)}/dispatches`, {
      method: 'POST',
      body: { ref: step.ref, inputs: step.inputs },
    });
    showMessage(messageEl, `Triggered ${step.workflowName} on ${step.owner}/${step.repo}@${step.ref}`, 'success');
  } catch (err) {
    showMessage(messageEl, err.message);
  }
});

// ---- Flow builder ----------------------------------------------------------
const stepsEl = document.getElementById('flow-steps');

function addFlowStep() {
  const index = stepsEl.querySelectorAll('.flow-step').length;
  if (index > 0) {
    const arrow = document.createElement('div');
    arrow.className = 'arrow';
    arrow.textContent = '↓ on success';
    stepsEl.appendChild(arrow);
  }
  const step = document.createElement('div');
  step.className = 'flow-step';
  step.innerHTML = `<div class="block-header"><strong>Step ${index + 1}</strong>
    ${index > 0 ? '<button type="button" class="danger remove-step">Remove</button>' : ''}</div>`;
  buildStepFields(step);
  stepsEl.appendChild(step);
}

stepsEl.addEventListener('click', (e) => {
  const btn = e.target.closest('.remove-step');
  if (!btn) return;
  const step = btn.closest('.flow-step');
  const arrow = step.previousElementSibling;
  if (arrow && arrow.classList.contains('arrow')) arrow.remove();
  step.remove();
  stepsEl.querySelectorAll('.flow-step strong').forEach((s, i) => { s.textContent = `Step ${i + 1}`; });
});

document.getElementById('add-step').addEventListener('click', addFlowStep);

document.getElementById('flow-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const steps = [...stepsEl.querySelectorAll('.flow-step')].map(readStepFields);
    const flow = await api('/flows', {
      method: 'POST',
      body: { name: document.getElementById('flow-name').value, steps },
    });
    showMessage(messageEl, `Flow "${flow.name}" saved`, 'success');
    document.getElementById('flow-name').value = '';
    stepsEl.innerHTML = '';
    addFlowStep();
    loadFlows();
  } catch (err) {
    showMessage(messageEl, err.message);
  }
});

// ---- Flows list ------------------------------------------------------------
const flowsEl = document.getElementById('flows');

function describeSteps(steps) {
  return steps
    .map((s) => `${escapeHtml(s.owner)}/${escapeHtml(s.repo)} · ${escapeHtml(s.workflowName || s.workflow)} @ ${escapeHtml(s.ref)}`)
    .join(' <strong>→</strong> ');
}

async function loadFlows() {
  try {
    const flows = await api('/flows');
    flowsEl.innerHTML = flows.length
      ? flows.map((f) => `<li>
          <div><strong>${escapeHtml(f.name)}</strong><div class="muted">${describeSteps(f.steps)}</div></div>
          <div class="card-actions" style="margin:0">
            <button type="button" class="primary" data-run="${escapeHtml(f.id)}">Run</button>
            <button type="button" class="danger" data-delete="${escapeHtml(f.id)}">Delete</button>
          </div>
        </li>`).join('')
      : '<li class="muted">No flows yet.</li>';
  } catch (err) {
    flowsEl.innerHTML = `<li class="message error">${escapeHtml(err.message)}</li>`;
  }
}

flowsEl.addEventListener('click', async (e) => {
  const run = e.target.closest('[data-run]');
  const del = e.target.closest('[data-delete]');
  try {
    if (run) {
      await api(`/flows/${encodeURIComponent(run.dataset.run)}/run`, { method: 'POST' });
      showMessage(messageEl, 'Flow started', 'success');
      loadExecutions();
    } else if (del) {
      if (!confirm('Delete this flow?')) return;
      await api(`/flows/${encodeURIComponent(del.dataset.delete)}`, { method: 'DELETE' });
      loadFlows();
    }
  } catch (err) {
    showMessage(messageEl, err.message);
  }
});

// ---- Executions ------------------------------------------------------------
const executionsEl = document.getElementById('executions');
const execLiveEl = document.getElementById('exec-live');
let execTimer = null;

async function loadExecutions() {
  clearTimeout(execTimer);
  try {
    const executions = await api('/executions');
    executionsEl.innerHTML = executions.length
      ? executions.map((x) => `<div class="card" style="margin-bottom:10px">
          <h3><span>${escapeHtml(x.flowName)} ${statusBadge(x.status)}</span>
            <span class="muted">${timeAgo(x.startedAt)}</span></h3>
          ${x.error ? `<div class="message error">${escapeHtml(x.error)}</div>` : ''}
          <ol class="steps">${x.steps.map((s) => `<li>
            ${statusBadge(s.status, s.conclusion)}
            <a href="${repoPageUrl(s.owner, s.repo)}">${escapeHtml(s.owner)}/${escapeHtml(s.repo)}</a>
            · ${escapeHtml(s.workflowName || s.workflow)} @ ${escapeHtml(s.ref)}
            ${s.runUrl ? `· <a href="${escapeHtml(safeUrl(s.runUrl))}" target="_blank" rel="noopener">run ↗</a>` : ''}
            ${s.error ? `<span class="muted">— ${escapeHtml(s.error)}</span>` : ''}
          </li>`).join('')}</ol>
        </div>`).join('')
      : '<p class="muted">No executions yet.</p>';
    const anyRunning = executions.some((x) => x.status === 'running');
    execLiveEl.hidden = !anyRunning;
    if (anyRunning) execTimer = setTimeout(loadExecutions, 3000);
  } catch (err) {
    executionsEl.innerHTML = `<div class="message error">${escapeHtml(err.message)}</div>`;
  }
}
document.getElementById('exec-refresh').addEventListener('click', loadExecutions);

// ---- Init ------------------------------------------------------------------
(async () => {
  try {
    repos = await api('/repos');
  } catch (err) {
    showMessage(messageEl, err.message);
  }
  if (!repos.length) {
    showMessage(messageEl, 'Register repositories on the dashboard first.');
  }
  buildStepFields(triggerFields, preselected);
  addFlowStep();
  loadFlows();
  loadExecutions();
})();
