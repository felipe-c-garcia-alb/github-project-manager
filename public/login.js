'use strict';

(function main() {
  const message = document.getElementById('message');
  const form = document.getElementById('auth-form');
  const toggle = document.getElementById('toggle');
  const password = document.getElementById('password');
  let mode = 'login';

  // Only redirect to pages of this app (prevents open redirects through ?next=).
  const next = new URLSearchParams(location.search).get('next') || '';
  const target = /^[a-z]+\.html(\?[^#]*)?$/.test(next) ? next : 'index.html';

  function setMode(newMode) {
    mode = newMode;
    const signup = mode === 'signup';
    document.getElementById('title').textContent = signup ? 'Create account' : 'Sign in';
    document.getElementById('submit').textContent = signup ? 'Create account' : 'Sign in';
    toggle.textContent = signup ? 'I already have an account' : 'Create an account';
    password.autocomplete = signup ? 'new-password' : 'current-password';
    password.minLength = signup ? 10 : 1;
    showMessage(message, '');
  }

  toggle.addEventListener('click', () => setMode(mode === 'login' ? 'signup' : 'login'));

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await api(`/auth/${mode}`, {
        method: 'POST',
        body: { username: document.getElementById('username').value, password: password.value },
      });
      location.href = target;
    } catch (err) {
      showMessage(message, err.message);
    }
  });

  api('/auth/status')
    .then((status) => {
      if (status.user) {
        location.href = target;
        return;
      }
      toggle.hidden = !status.signupOpen;
      if (status.setupRequired) {
        // On a fresh install nobody can sign in yet, so start with sign-up.
        document.getElementById('first-user').hidden = false;
        setMode('signup');
      }
    })
    .catch((err) => showMessage(message, err.message));
})();
