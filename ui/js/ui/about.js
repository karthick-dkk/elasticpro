/**
 * Who made this, where it lives, and where to ask for help.
 *
 * One definition of the project's identity. The status strip, the setup screen and the
 * About dialog all read these constants, so the repository URL cannot end up saying two
 * different things — which is exactly how a support link goes stale.
 *
 * Links never navigate the window. In the desktop app the WebView is the app: following a
 * link inside it would replace ElasticPro with GitHub and leave no way back, so every
 * one of these goes out through the OS browser via the opener plugin.
 */

import { h } from '../lib/dom.js';
import { openExternal } from '../core/platform.js';
import { modal } from './modal.js';

export const AUTHOR = 'karthickdk';
export const REPO = 'https://github.com/karthick-dkk/elasticpro';
export const ISSUES = `${REPO}/issues`;
export const NEW_ISSUE = `${REPO}/issues/new`;
export const RELEASES = `${REPO}/releases`;
export const LICENSE = 'MIT';

/** An external link that opens in the real browser, not in the app window. */
export function extLink(label, url, title) {
  return h('a.ext', {
    href: url,
    title: title || url,
    // Real href so the link can be focused, and copied from the context menu; the click
    // is intercepted because navigating this window would close the app over itself.
    onclick: (e) => { e.preventDefault(); openExternal(url); },
    onkeydown: (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      openExternal(url);
    },
  }, label);
}

/**
 * The mini view: one compact group for the status strip.
 *
 * Deliberately three short items and no icons — the strip already carries the config
 * name, cluster count, health, build and request load, and this must not compete with
 * any of them for attention.
 */
export function aboutMini(version) {
  return h('span.row.credits',
    // No version here: the strip already carries one in its Build row, and the setup
    // screen in its core line. Twice on the same line is noise; the dialog behind this
    // button is where the full detail belongs.
    h('button.linkish', {
      title: 'About ElasticPro',
      onclick: () => aboutDialog(version),
    }, 'ElasticPro'),
    h('span.sep', '·'),
    h('span', 'by ', extLink(AUTHOR, `https://github.com/karthick-dkk`, `${AUTHOR} on GitHub`)),
    h('span.sep', '·'),
    extLink('GitHub', REPO, 'Source code and releases'),
    h('span.sep', '·'),
    extLink('Support', ISSUES, 'Report a problem or ask a question'));
}

/** The same facts with room to breathe, for anyone who clicks the name. */
export function aboutDialog(version) {
  const line = (k, v) => h('div', { style: { display: 'flex', gap: '10px', padding: '3px 0' } },
    h('b', { style: { minWidth: '92px', color: 'var(--text-secondary)' } }, k),
    h('span', v));

  return modal('ElasticPro',
    'Multi-cluster Elasticsearch monitoring — including clusters reachable only through an SSH jump host.',
    [
      h('div', { style: { fontSize: '12.5px', lineHeight: '1.7' } },
        // The version is here because it is the first thing a bug report needs and the
        // last thing anyone remembers to include.
        line('Version', h('span.mono', version ? `v${version}` : 'unknown')),
        line('Author', extLink(AUTHOR, 'https://github.com/karthick-dkk')),
        line('Source', extLink(REPO.replace('https://', ''), REPO)),
        line('Support', extLink('Report a problem or ask a question', NEW_ISSUE)),
        line('Releases', extLink('Downloads and change log', RELEASES)),
        line('Licence', LICENSE)),
      h('div.banner', { style: { marginTop: '12px' } },
        h('div',
          h('div.ttl', 'If you are reporting a problem'),
          h('div',
            'Include the version above and what the status strip showed. Never paste your '
            + 'config file or a screenshot of the Config page — both carry the cluster '
            + 'credential, and an issue is public.'))),
    ],
    (ctx) => [h('button.btn.primary', { onclick: () => ctx.done(true) }, 'Close')],
    { width: '540px' });
}
