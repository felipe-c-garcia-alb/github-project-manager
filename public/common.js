'use strict';

/* Shared helpers for all pages. */

async function api(path, options = {}) {
  const opts = { ...options, headers: { 'X-Requested-With': 'XMLHttpRequest', ...(options.headers || {}) } };
  if (opts.body !== undefined && typeof opts.body !== 'string') {
    opts.body = JSON.stringify(opts.body);
    opts.headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(`/api${path}`, { credentials: 'same-origin', ...opts });
  if (res.status === 401 && !path.startsWith('/auth/') && !location.pathname.endsWith('/login.html')) {
    location.href = `login.html?next=${encodeURIComponent(location.pathname.slice(1) + location.search)}`;
    throw new Error('Sign in required');
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
  return data;
}

function escapeHtml(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function repoApiPath(owner, repo) {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

function repoPageUrl(owner, repo) {
  return `repo.html?repo=${encodeURIComponent(`${owner}/${repo}`)}`;
}

function safeUrl(url) {
  return /^https:\/\//i.test(String(url || '')) ? url : '#';
}

function timeAgo(iso) {
  if (!iso) return '';
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function statusBadge(status, conclusion) {
  const label = status === 'completed' ? conclusion || 'completed' : status || 'unknown';
  return `<span class="badge badge-${escapeHtml(label)}">${escapeHtml(label.replace(/_/g, ' '))}</span>`;
}

function showMessage(el, text, type = 'error') {
  el.textContent = text;
  el.className = `message ${type}`;
  el.hidden = !text;
}

function renderNav(active) {
  const nav = document.getElementById('nav');
  if (!nav) return;
  const links = [
    ['index.html', 'Dashboard', 'dashboard'],
    ['actions.html', 'Triggers & Flows', 'actions'],
    ['settings.html', 'Settings', 'settings'],
  ];
  nav.innerHTML = `<span class="brand">GitHub Project Manager</span>${links
    .map(([href, label, key]) => `<a href="${href}" class="${key === active ? 'active' : ''}">${label}</a>`)
    .join('')}<span class="nav-right"><a id="token-warning" class="token-warning" href="settings.html" hidden>No GitHub token set</a>`
    + '<span id="nav-user" class="nav-user"></span><button type="button" id="logout" class="link">Sign out</button></span>';
  document.getElementById('logout').addEventListener('click', async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => {});
    location.href = 'login.html';
  });
  api('/me')
    .then((me) => {
      document.getElementById('nav-user').textContent = me.username;
      document.getElementById('token-warning').hidden = me.githubToken.set;
    })
    .catch(() => {});
}
