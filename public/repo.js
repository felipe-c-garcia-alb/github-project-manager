'use strict';

renderNav('');

const RUN_POLL_MS = 3000;
const LIST_POLL_MS = 15000;

const params = new URLSearchParams(location.search);
const [owner, repo] = (params.get('repo') || '').split('/');
const base = repoApiPath(owner || '', repo || '');
const messageEl = document.getElementById('message');

document.getElementById('title').textContent = `${owner}/${repo}`;
document.title = `${owner}/${repo} · GitHub Project Manager`;
document.getElementById('trigger-link').href = `actions.html?repo=${encodeURIComponent(`${owner}/${repo}`)}`;

// ---- Pull requests ---------------------------------------------------------
const pullsEl = document.getElementById('pulls');
const prStateEl = document.getElementById('pr-state');

async function loadPulls() {
  pullsEl.innerHTML = '<li class="muted">Loading…</li>';
  try {
    const pulls = await api(`${base}/pulls?state=${encodeURIComponent(prStateEl.value)}`);
    if (!pulls.length) {
      pullsEl.innerHTML = '<li class="muted">No pull requests.</li>';
      return;
    }
    pullsEl.innerHTML = pulls.map((p) => {
      const state = p.merged ? 'merged' : p.draft ? 'draft' : p.state;
      return `<li>
        <div>
          <a href="${escapeHtml(safeUrl(p.htmlUrl))}" target="_blank" rel="noopener">#${p.number} ${escapeHtml(p.title)}</a>
          <div class="muted">${escapeHtml(p.head)} → ${escapeHtml(p.base)} · by ${escapeHtml(p.user)} · updated ${timeAgo(p.updatedAt)}</div>
        </div>
        <span class="badge badge-${escapeHtml(state)}">${escapeHtml(state)}</span>
      </li>`;
    }).join('');
  } catch (err) {
    pullsEl.innerHTML = `<li class="message error">${escapeHtml(err.message)}</li>`;
  }
}
prStateEl.addEventListener('change', loadPulls);

// ---- Branches --------------------------------------------------------------
const branchesEl = document.getElementById('branches');
const branchFromEl = document.getElementById('branch-from');

async function loadBranches() {
  branchesEl.innerHTML = '<li class="muted">Loading…</li>';
  try {
    const branches = await api(`${base}/branches`);
    branchFromEl.innerHTML = branches
      .map((b) => `<option value="${escapeHtml(b.name)}" ${b.isDefault ? 'selected' : ''}>${escapeHtml(b.name)}</option>`)
      .join('');
    branchesEl.innerHTML = branches.map((b) => `<li>
        <div>
          <a href="https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/tree/${b.name.split('/').map(encodeURIComponent).join('/')}" target="_blank" rel="noopener">${escapeHtml(b.name)}</a>
          ${b.isDefault ? '<span class="badge badge-default">default</span>' : ''}
          ${b.protected ? '<span class="badge badge-protected">protected</span>' : ''}
          <div class="muted">${escapeHtml((b.sha || '').slice(0, 7))}</div>
        </div>
        ${b.isDefault || b.protected ? '' : `<button type="button" class="danger" data-delete-branch="${escapeHtml(b.name)}">Delete</button>`}
      </li>`).join('') || '<li class="muted">No branches.</li>';
  } catch (err) {
    branchesEl.innerHTML = `<li class="message error">${escapeHtml(err.message)}</li>`;
  }
}

document.getElementById('create-branch').addEventListener('submit', async (e) => {
  e.preventDefault();
  const nameEl = document.getElementById('branch-name');
  try {
    await api(`${base}/branches`, { method: 'POST', body: { name: nameEl.value.trim(), from: branchFromEl.value } });
    showMessage(messageEl, `Branch ${nameEl.value} created from ${branchFromEl.value}`, 'success');
    nameEl.value = '';
    loadBranches();
  } catch (err) {
    showMessage(messageEl, err.message);
  }
});

branchesEl.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-delete-branch]');
  if (!btn) return;
  const name = btn.dataset.deleteBranch;
  if (!confirm(`Delete branch "${name}"? This cannot be undone.`)) return;
  try {
    await api(`${base}/branches?name=${encodeURIComponent(name)}`, { method: 'DELETE' });
    showMessage(messageEl, `Branch ${name} deleted`, 'success');
    loadBranches();
  } catch (err) {
    showMessage(messageEl, err.message);
  }
});
document.getElementById('branches-refresh').addEventListener('click', loadBranches);

// ---- Actions ---------------------------------------------------------------
const runsEl = document.getElementById('runs');
const runsLiveEl = document.getElementById('runs-live');
const runPollers = new Map();

function runSummaryHtml(run) {
  return `${statusBadge(run.status, run.conclusion)}
    <strong>${escapeHtml(run.name)}</strong>
    <span>${escapeHtml(run.displayTitle || '')}</span>
    <span class="muted">#${run.runNumber} · ${escapeHtml(run.event)} · ${escapeHtml(run.branch)} · ${timeAgo(run.createdAt)}</span>
    ${run.status !== 'completed' ? '<span class="live">live</span>' : ''}
    <a href="${escapeHtml(safeUrl(run.htmlUrl))}" target="_blank" rel="noopener">GitHub ↗</a>`;
}

function createRunElement(run) {
  const details = document.createElement('details');
  details.className = 'run';
  details.dataset.runId = run.id;
  details.innerHTML = `<summary>${runSummaryHtml(run)}</summary>
    <div class="run-body">
      <div class="field">
        <label>Job</label>
        <select class="job-select"><option value="">Loading jobs…</option></select>
      </div>
      <ol class="steps"></ol>
      <div class="muted log-status"></div>
      <pre class="logs" hidden></pre>
    </div>`;
  details.addEventListener('toggle', () => {
    if (details.open) startRunPolling(details);
    else stopRunPolling(details);
  });
  details.querySelector('.job-select').addEventListener('change', () => refreshRun(details, true));
  return details;
}

function stopRunPolling(details) {
  const id = details.dataset.runId;
  clearTimeout(runPollers.get(id));
  runPollers.delete(id);
}

function startRunPolling(details) {
  stopRunPolling(details);
  refreshRun(details, true);
}

async function refreshRun(details, forceLogs) {
  const runId = details.dataset.runId;
  clearTimeout(runPollers.get(runId));
  const select = details.querySelector('.job-select');
  const stepsEl = details.querySelector('.steps');
  const logStatus = details.querySelector('.log-status');
  const logsEl = details.querySelector('.logs');
  let running = false;
  try {
    const [run, jobs] = await Promise.all([
      api(`${base}/runs/${runId}`),
      api(`${base}/runs/${runId}/jobs`),
    ]);
    running = run.status !== 'completed';
    details.querySelector('summary').innerHTML = runSummaryHtml(run);

    const previous = select.value;
    select.innerHTML = jobs.length
      ? jobs.map((j) => `<option value="${j.id}">${escapeHtml(j.name)} — ${escapeHtml(j.status === 'completed' ? j.conclusion : j.status)}</option>`).join('')
      : '<option value="">No jobs yet</option>';
    if (previous && jobs.some((j) => String(j.id) === previous)) select.value = previous;
    else {
      const active = jobs.find((j) => j.status !== 'completed');
      if (active) select.value = String(active.id);
    }

    const job = jobs.find((j) => String(j.id) === select.value);
    stepsEl.innerHTML = job
      ? job.steps.map((s) => `<li>${statusBadge(s.status, s.conclusion)} ${escapeHtml(s.name)}</li>`).join('')
      : '';

    if (job && (forceLogs || job.status !== 'completed' || logsEl.dataset.jobId !== String(job.id) || logsEl.dataset.complete !== 'true')) {
      const result = await api(`${base}/jobs/${job.id}/logs`);
      if (result.available) {
        const atBottom = logsEl.scrollTop + logsEl.clientHeight >= logsEl.scrollHeight - 20;
        logsEl.textContent = result.logs;
        logsEl.hidden = false;
        if (atBottom || logsEl.dataset.jobId !== String(job.id)) logsEl.scrollTop = logsEl.scrollHeight;
        logStatus.textContent = job.status === 'completed' ? '' : 'Job in progress — logs refresh automatically.';
      } else {
        logsEl.hidden = true;
        logsEl.textContent = '';
        logStatus.textContent = job.status === 'completed'
          ? 'Logs are not available for this job.'
          : 'Job in progress — GitHub publishes the full log when the job finishes. Step progress above updates live.';
      }
      logsEl.dataset.jobId = String(job.id);
      logsEl.dataset.complete = String(job.status === 'completed' && result.available);
    } else if (!job) {
      logsEl.hidden = true;
      logStatus.textContent = running ? 'Waiting for jobs to start…' : '';
    }
  } catch (err) {
    logStatus.textContent = err.message;
  }
  if (details.open && details.isConnected && running) {
    runPollers.set(runId, setTimeout(() => refreshRun(details, false), RUN_POLL_MS));
  }
}

let listTimer = null;
async function loadRuns() {
  clearTimeout(listTimer);
  try {
    const runs = await api(`${base}/runs`);
    if (!runs.length) {
      runsEl.querySelectorAll('details.run').forEach(stopRunPolling);
      runsEl.innerHTML = '<p class="muted">No workflow runs.</p>';
    } else {
      runsEl.querySelectorAll(':scope > p').forEach((p) => p.remove());
      const existing = new Map([...runsEl.querySelectorAll('details.run')].map((d) => [d.dataset.runId, d]));
      const keep = new Set();
      runs.forEach((run, index) => {
        const id = String(run.id);
        keep.add(id);
        let el = existing.get(id);
        if (!el) el = createRunElement(run);
        else if (!runPollers.has(id)) el.querySelector('summary').innerHTML = runSummaryHtml(run);
        const current = runsEl.children[index];
        if (current !== el) runsEl.insertBefore(el, current || null);
      });
      existing.forEach((el, id) => {
        if (!keep.has(id)) {
          stopRunPolling(el);
          el.remove();
        }
      });
    }
    const anyRunning = runs.some((r) => r.status !== 'completed');
    runsLiveEl.hidden = !anyRunning;
    if (anyRunning) listTimer = setTimeout(loadRuns, LIST_POLL_MS);
  } catch (err) {
    runsEl.querySelectorAll('details.run').forEach(stopRunPolling);
    runsEl.innerHTML = `<div class="message error">${escapeHtml(err.message)}</div>`;
  }
}
document.getElementById('runs-refresh').addEventListener('click', loadRuns);

if (!owner || !repo) {
  showMessage(messageEl, 'No repository selected. Go back to the dashboard and choose one.');
} else {
  loadPulls();
  loadBranches();
  loadRuns();
}
