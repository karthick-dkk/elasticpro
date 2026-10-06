/**
 * Sign in, and the first-run screen that creates the first administrator.
 *
 * Only the installed and hosted builds ever reach this. The portable build has no
 * accounts at all — see `Edition` in crates/elasticpro-core/src/auth.rs — so `authState()`
 * reports `required: false` there and the app boots straight into the dashboard exactly
 * as it always did.
 *
 * This is a full-screen gate rather than a modal on purpose: until there is a session
 * there is nothing behind it worth looking at, and a dismissible dialog in front of an
 * empty app invites people to try dismissing it.
 *
 * It says as little as it can. This is the one screen every unauthenticated visitor
 * reaches, so it carries no credential and no hint at one, no description of what the
 * roles are or why, and nothing about how or where passwords are stored — "delete
 * users.json to start again" tells an attacker the filename and tells a legitimate user
 * nothing they can act on from a browser.
 *
 * The first password is made per install and left in the data directory and the server
 * log on first start instead, where an operator can read it and a visitor cannot. The roles are for the administrator
 * assigning them, on the Accounts page, behind a session.
 */

import { h, mount } from '../lib/dom.js';
import { bridge, setSession } from '../core/transport.js';

const MIN_PASSWORD = 10;   // must match auth::MIN_PASSWORD

/** What the core says about accounts on this build. */
export async function authState() {
  const res = await bridge({ type: 'WHOAMI' });
  if (!res || res.ok !== true) return { required: false, bootstrap: false, caller: null };
  return {
    required: !!res.authRequired,
    bootstrap: !!res.needsBootstrap,
    apiTokens: !!res.apiTokens,
    edition: res.edition || 'portable',
    caller: res.caller || null,
  };
}

export async function signOut() {
  await bridge({ type: 'LOGOUT' });
  setSession('');
}

/**
 * Draw the gate into `root` and resolve once somebody is signed in.
 *
 * Resolves with the caller, so the shell can render a role-appropriate UI without asking
 * again.
 */
export function loginScreen(root, { bootstrap = false, mode: startMode = null, hint = null, notice = '' } = {}) {
  return new Promise((resolve) => {
    let busy = false;
    // A Zabbix sign-in that failed lands here, and the reason is worth more than an empty
    // form: "the link expired" and "the secrets differ" call for different fixes.
    let error = notice || '';
    let mode = startMode || (bootstrap ? 'bootstrap' : 'login');

    const submit = async () => {
      if (busy) return;
      const name = (document.getElementById('login-name') || {}).value || '';
      const password = (document.getElementById('login-pw') || {}).value || '';
      const confirm = (document.getElementById('login-pw2') || {}).value || '';

      if (mode === 'change') {
        if (password.length < MIN_PASSWORD) {
          error = `The new password must be at least ${MIN_PASSWORD} characters.`;
          return draw();
        }
        if (password !== confirm) { error = 'The two passwords do not match.'; return draw(); }
        busy = true; error = ''; draw();
        const res = await bridge({ type: 'USER_SET_PASSWORD', name: hint.name, password });
        busy = false;
        if (res && res.ok) {
          try { document.body.classList.remove('auth-bg'); } catch { /* not a browser */ }
          return resolve({ ...hint, mustChange: false });
        }
        error = (res && res.message) || 'Could not set the password.';
        return draw();
      }
      if (!name.trim()) { error = 'Enter a user name.'; return draw(); }
      if (mode === 'bootstrap') {
        if (password.length < MIN_PASSWORD) {
          error = `The password must be at least ${MIN_PASSWORD} characters.`;
          return draw();
        }
        if (password !== confirm) { error = 'The two passwords do not match.'; return draw(); }
      }

      busy = true; error = ''; draw();
      const res = await bridge({
        type: mode === 'bootstrap' ? 'BOOTSTRAP_ADMIN' : 'LOGIN',
        name: name.trim(),
        password,
      });
      busy = false;

      if (res && res.ok && res.session) {
        setSession(res.session);
        const who = res.caller || { name: name.trim(), role: 'admin' };
        // The shipped password gets you exactly this screen. The core refuses everything
        // else until it changes, so sending them on to a dashboard that cannot load
        // would only look broken.
        if (who.mustChange) {
          hint = who; mode = 'change'; error = '';
          return draw();
        }
        try { document.body.classList.remove('auth-bg'); } catch { /* not a browser */ }
        return resolve(who);
      }
      error = (res && res.message) || 'Sign-in failed.';
      draw();
      const pw = document.getElementById('login-pw');
      if (pw) { pw.value = ''; pw.focus(); }
    };

    const onKey = (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } };

    function draw() {
      const first = mode === 'bootstrap';
      const changing = mode === 'change';
      // Both the first-run and the forced-change screens ask for a password twice.
      const twice = first || changing;
      // Only while the gate is up — the dashboard behind it wants a plain surface, not
      // a backdrop competing with charts.
      try { document.body.classList.add('auth-bg'); } catch { /* not a browser */ }
      const panel = h('div.setup',
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '14px' } },
          h('img', { src: 'icons/icon48.png', width: 34, height: 34, alt: '' }),
          h('div',
            h('h2', 'ElasticPro'),
            h('div.muted', { style: { fontSize: '12.5px' } },
              changing
                ? `Signed in as ${hint && hint.name}. Choose a password before going any further.`
                : first
                  ? 'No accounts exist yet. Create the administrator for this installation.'
                  : 'Sign in to continue.'))),

        error ? h('div.banner.err', { role: 'alert' }, h('div',
          h('div.ttl', changing ? 'Could not set the password' : first ? 'Could not create the account' : 'Could not sign in'),
          h('div', error))) : null,

        h('div.card', h('div.body',
          changing ? null : h('label.field',
            h('span', 'User name'),
            h('input#login-name', {
              type: 'text', autocomplete: 'username', autofocus: true,
              spellcheck: 'false', autocapitalize: 'none', onkeydown: onKey,
            })),
          h('label.field', { style: { marginTop: '10px' } },
            h('span', changing ? 'New password' : 'Password'),
            h('input#login-pw', {
              type: 'password',
              autocomplete: twice ? 'new-password' : 'current-password',
              onkeydown: onKey,
            }),
            twice ? h('span.sec', { style: { fontSize: '11.5px' } },
              `At least ${MIN_PASSWORD} characters.`) : null),
          twice
            ? h('label.field', { style: { marginTop: '10px' } },
                h('span', 'Repeat the password'),
                h('input#login-pw2', { type: 'password', autocomplete: 'new-password', onkeydown: onKey }))
            : null,

          h('div', { style: { display: 'flex', gap: '8px', marginTop: '14px', alignItems: 'center' } },
            h('button.btn.primary', { disabled: busy, onclick: submit },
              busy ? 'Working…' : changing ? 'Set password and continue' : first ? 'Create administrator' : 'Sign in')))),
      );

      // Two columns: the supplied brand panel on the left, the real form on the right.
      // The mock-up drew a form in its right half; that half is cropped off rather than
      // placed under this one, which would have been a picture of a form behind a form.
      mount(root, h('div.auth-split',
        h('div.auth-brand', { role: 'presentation' }),
        h('div.auth-form', panel)));
      const el = document.getElementById(changing ? 'login-pw' : 'login-name');
      if (el && !busy) el.focus();
    }

    draw();
  });
}
