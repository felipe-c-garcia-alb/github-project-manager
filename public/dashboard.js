'use strict';

renderNav('dashboard');

const reposEl = document.getElementById('repos');
const emptyEl = document.getElementById('empty');
const messageEl = document.getElementById('message');

function stat(value, label) {
  return `<div class="stat"><div class="value">${escapeHtml(value)}</div><div class="label">${escapeHtml(label)}</div></div>`;
}

function renderCard(r) {
  const s = r.summary;
  const body = s
    ? `<div class="stats">
        ${stat(s.branches, 'Branches')}
        ${stat(s.tags, 'Tags')}
        ${stat(s.openPullRequests, 'Open PRs')}
        ${stat(s.workflows, 'Workflows')}
        ${stat(s.workflowRuns, 'Action runs')}
        ${stat(s.runningWorkflowRuns, 'Running')}
      </div>`
    : `<div class="message error">${escapeHtml(r.error || 'Unable to load data')}</div>`;
  return `<div class="card">
    <h3><a href="${repoPageUrl(r.owner, r.repo)}">${escapeHtml(r.fullName)}</a>
      <a class="muted" href="${escapeHtml(safeUrl(r.htmlUrl))}" target="_blank" rel="noopener">GitHub ↗</a></h3>
    ${body}
    <div class="card-actions">
      <a href="${repoPageUrl(r.owner, r.repo)}"><button type="button">Manage</button></a>
      <button type="button" class="danger" data-remove="${escapeHtml(r.owner)}/${escapeHtml(r.repo)}">Remove</button>
    </div>
  </div>`;
}

async function load() {
  reposEl.innerHTML = '<p class="muted">Loading…</p>';
  try {
    const repos = await api('/dashboard');
    emptyEl.hidden = repos.length > 0;
    reposEl.innerHTML = repos.map(renderCard).join('');
  } catch (err) {
    reposEl.innerHTML = '';
    showMessage(messageEl, err.message);
  }
}

document.getElementById('add-repo').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = document.getElementById('repo-name');
  try {
    const repo = await api('/repos', { method: 'POST', body: { fullName: input.value } });
    showMessage(messageEl, `Registered ${repo.fullName}`, 'success');
    input.value = '';
    load();
  } catch (err) {
    showMessage(messageEl, err.message);
  }
});

document.getElementById('refresh').addEventListener('click', load);

reposEl.addEventListener('click', async (e) => {
  const target = e.target.closest('[data-remove]');
  if (!target) return;
  const [owner, repo] = target.dataset.remove.split('/');
  if (!confirm(`Remove ${owner}/${repo} from the project manager?`)) return;
  try {
    await api(repoApiPath(owner, repo), { method: 'DELETE' });
    load();
  } catch (err) {
    showMessage(messageEl, err.message);
  }
});

load();
