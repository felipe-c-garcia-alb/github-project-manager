'use strict';

(function main() {
  renderNav('settings');
  const message = document.getElementById('message');
  const status = document.getElementById('token-status');
  const input = document.getElementById('token');
  const removeButton = document.getElementById('remove');

  function render(token) {
    if (token.set) {
      const who = token.githubLogin ? ` for GitHub user <strong>${escapeHtml(token.githubLogin)}</strong>` : '';
      status.innerHTML = `Token set${who}, ending in <code>…${escapeHtml(token.last4)}</code>`
        + ` <span class="muted">(updated ${escapeHtml(timeAgo(token.updatedAt))})</span>.`;
    } else {
      status.textContent = 'No token set. GitHub data cannot be loaded until you add one.';
    }
    document.getElementById('token-label').textContent = token.set ? 'Replace token' : 'Token';
    removeButton.hidden = !token.set;
    const warning = document.getElementById('token-warning');
    if (warning) warning.hidden = token.set;
  }

  async function load() {
    try {
      render((await api('/me')).githubToken);
    } catch (err) {
      showMessage(message, err.message);
    }
  }

  document.getElementById('token-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = document.getElementById('save');
    button.disabled = true;
    try {
      render(await api('/me/token', { method: 'PUT', body: { token: input.value.trim() } }));
      showMessage(message, 'Token verified with GitHub and saved.', 'success');
    } catch (err) {
      showMessage(message, err.message);
    } finally {
      input.value = '';
      button.disabled = false;
    }
  });

  removeButton.addEventListener('click', async () => {
    if (!window.confirm('Remove your GitHub token? Running flows you started will fail at their next step.')) return;
    try {
      await api('/me/token', { method: 'DELETE' });
      render({ set: false });
      showMessage(message, 'Token removed.', 'success');
    } catch (err) {
      showMessage(message, err.message);
    }
  });

  load();
})();
