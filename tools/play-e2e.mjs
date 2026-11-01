#!/usr/bin/env node
/**
 * Play end to end, against a hosted server that is already running (it starts nothing):
 * a display link made by an administrator, opened on a "TV" (Playwright Chromium at
 * 1920x1080), the Fleet wall drawn from the real core, the TV's session refused anything
 * that is not Play, and the TV told so when the link is revoked.
 *
 *   ELASTICPRO_BIND=0.0.0.0 ELASTICPRO_DATA_DIR=$(mktemp -d) ELASTICPRO_CONFIG=<config.json> \
 *     ELASTICPRO_INITIAL_ADMIN_PASSWORD_FILE=<file> target/debug/elasticpro-bridge ui 18865 &
 *   node tools/mock-es.mjs 9299 &          # whatever the config's clusters point at
 *   node tools/play-e2e.mjs --base http://127.0.0.1:18865 --user Admin --password-file <file>
 *
 * --password <p> (or $ELASTICPRO_E2E_PASSWORD) instead of --password-file. The account must be
 * an administrator who sees every cluster (display links reach every cluster). The link it
 * makes is revoked before it exits, pass or fail.
 *
 * What it proves, each against the real core and the real UI:
 *   0. (setup) the server knows its clusters: on a fresh install nobody has opened the app yet,
 *      so an administrator's browser opens it once, which hands the server its cluster list
 *      (PRIME), as on any hosted install. A TV cannot: PRIME is not a display link's.
 *   1. PLAY_LINK_CREATE answers a URL with the secret once; PLAY_LINK_LIST never shows it.
 *   2. #/play?display=<secret> becomes a session cookie the page cannot read (HttpOnly), the
 *      secret leaves the address, and the Fleet wall draws a tile per cluster with no scroll bar.
 *   3. The TV's session: WHOAMI says playOnly; CONFIG_WRITE is refused (forbidden, playOnly);
 *      an Elasticsearch search that is not the log-delay measurement is refused; CLUSTER_META_GET
 *      is answered; the measurer's own PLAY_SHARE_PUT payload (play/measure.js shareData) is
 *      kept and reads back through fromShare.
 *   4. PLAY_LINK_REVOKE: the TV shows "This display link was not accepted" at its next request to the core (Play asks at least once a minute; three minutes allowed).
 *
 * Needs playwright with chromium (see tools/lib/playwright.mjs). Exits 0 with a notice when
 * it is absent, like the other browser checks.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlaywright } from './lib/playwright.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const BASE = arg('--base', 'http://127.0.0.1:8443').replace(/\/$/, '');
const USER = arg('--user', 'Admin');
const PWFILE = arg('--password-file', '');
const PASSWORD = PWFILE ? fs.readFileSync(PWFILE, 'utf8').split(/\r?\n/)[0] : arg('--password', process.env.ELASTICPRO_E2E_PASSWORD || '');
const HEADED = process.argv.includes('--headed');
if (!PASSWORD) { console.error('play-e2e: give --password-file, --password or $ELASTICPRO_E2E_PASSWORD'); process.exit(2); }

const pw = await loadPlaywright(ROOT, 'play-e2e');
if (!pw) process.exit(0);

let failed = 0;
const ok = (cond, what, detail = '') => {
  if (cond) console.log(`  ✓ ${what}`);
  else { failed++; console.log(`  ✗ ${what}${detail ? ` (${detail})` : ''}`); }
  return cond;
};

/** One message to the core as the administrator. */
let adminCookie = '';
async function admin(msg) {
  const r = await fetch(`${BASE}/bridge`, { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE, ...(adminCookie ? { cookie: adminCookie } : {}) },
    body: JSON.stringify(msg) });
  const sc = r.headers.get('set-cookie') || '';
  const m = /ep_session=[^;]+/.exec(sc);
  if (m && m[0] !== 'ep_session=') adminCookie = m[0];
  return r.json();
}

console.log(`play-e2e: ${BASE}`);
const login = await admin({ type: 'LOGIN', name: USER, password: PASSWORD });
if (!ok(login.ok && adminCookie, `signed in as ${USER}`, JSON.stringify(login))) process.exit(1);
if (!ok(login.caller && login.caller.role === 'admin' && !login.caller.scoped, 'an administrator who sees every cluster', JSON.stringify(login.caller))) process.exit(1);

const fleetIds = async () => ((await admin({ type: 'FLEET_STATE' })).clusterIds || []);

let browser = null;
let revoked = false;
let linkId = '';
try {
  browser = await pw.chromium.launch({ headless: !HEADED });

  /* 0. the server knows its clusters */
  if (!(await fleetIds()).length) {
    const actx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const [cn, cv] = adminCookie.split('=');
    await actx.addCookies([{ name: cn, value: cv, url: BASE }]);
    const ap = await actx.newPage();
    await ap.goto(`${BASE}/#/overview`);
    for (let i = 0; i < 90 && !(await fleetIds()).length; i++) await new Promise((r) => setTimeout(r, 1000));
    await actx.close();
  }
  const ids = await fleetIds();
  if (!ok(ids.length > 0, 'the server knows its clusters (an administrator\'s browser opened the app once)', `${ids.length}`)) throw new Error('no clusters');

  /* 1. the link */
  const name = `play-e2e ${new Date().toISOString().slice(0, 19)}`;
  const made = await admin({ type: 'PLAY_LINK_CREATE', name, clusters: 'all', expires: 1 });
  if (!ok(made.ok && made.secret && made.link && made.link.id, 'PLAY_LINK_CREATE made a link', JSON.stringify(made))) throw new Error('no link');
  const { secret } = made;
  linkId = made.link.id;
  ok(String(made.link.url || '').endsWith(`/#/play?display=${secret}`), 'its URL carries the secret, once', made.link.url);
  const listed = await admin({ type: 'PLAY_LINK_LIST' });
  ok(listed.ok && listed.links.some((l) => l.id === linkId) && !JSON.stringify(listed).includes(secret), 'PLAY_LINK_LIST names it and never the secret');

  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e && e.message || e)));

  /* 2. the TV opens it */
  await page.goto(`${BASE}/#/play?display=${encodeURIComponent(secret)}`);
  const wall = await page.waitForFunction(() => {
    const t = document.querySelector('.pl-title');
    return t && t.textContent === 'Fleet' && document.querySelectorAll('.pl-tile[data-cluster]').length > 0;
  }, null, { timeout: 90000 }).then(() => true).catch(() => false);
  ok(wall, 'the Fleet wall drew, with a tile per cluster', wall ? '' : (await page.evaluate(() => document.body.innerText.slice(0, 300))));
  const seen = await page.evaluate(() => ({
    hash: location.hash, cookie: document.cookie, play: document.documentElement.classList.contains('play'),
    tiles: document.querySelectorAll('.pl-tile[data-cluster]').length,
    cluster: (document.querySelector('.pl-tile[data-cluster]') || { dataset: {} }).dataset.cluster || '',
    scrollX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    scrollY: document.documentElement.scrollHeight > document.documentElement.clientHeight,
    exit: !!document.querySelector('.pl-exit'),
  }));
  ok(!seen.hash.includes(secret), 'the secret left the address', seen.hash);
  ok(!/ep_session/.test(seen.cookie), 'the session is a cookie the page cannot read (HttpOnly)');
  ok(seen.play && !seen.exit, 'full screen, no way out of Play on a display link');
  ok(!seen.scrollX && !seen.scrollY, 'no scroll bar at 1920x1080');
  console.log(`    ${seen.tiles} tile(s)`);

  /* 3. what the TV's session may do */
  const asTv = (msg) => page.evaluate(async (m) => {
    const r = await fetch('/bridge', { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(m) });
    return r.json();
  }, msg);
  const who = await asTv({ type: 'WHOAMI' });
  ok(who.caller && who.caller.playOnly === true && who.caller.name === `display:${name}`, 'WHOAMI: the display, play-only', JSON.stringify(who.caller));
  const write = await asTv({ type: 'CONFIG_WRITE', path: '/tmp/play-e2e', text: 'x' });
  ok(write.ok === false && write.kind === 'forbidden' && write.playOnly === true, 'CONFIG_WRITE is refused to the TV', JSON.stringify(write));
  const wide = await asTv({ type: 'ES', clusterId: seen.cluster, method: 'GET', path: '/*,.*/_search?expand_wildcards=all', body: JSON.stringify({ size: 10000 }) });
  ok(wide.ok === false && wide.kind === 'forbidden', 'a search that is not the log-delay measurement is refused', JSON.stringify(wide).slice(0, 200));
  // The log-delay measurement itself, as the page sends it (core/log-delay.js through the app's
  // own client for that cluster): allowed, where the search above was not.
  const measured = await page.evaluate(async (id) => {
    const st = await import('/js/core/state.js');
    const ld = await import('/js/core/log-delay.js');
    const c = st.clusters().find((x) => x.id === id);
    const cl = st.client(id);
    const pre = await ld.preflight(cl, c);
    const resolved = pre.ok ? pre.resolved : { arrival: '@timestamp', eventTime: '@timestamp', device: 'host.keyword', metadata: [] };
    const res = await cl.request('POST', `/${encodeURIComponent(c.logIndexPattern || 'logstash-*')}/_search?ignore_unavailable=true&allow_no_indices=true`,
      ld.buildSearchBody(resolved, { from: 'now-24h', to: 'now', size: 500 }));
    return { pre: { ok: pre.ok, unknown: pre.unknown, error: pre.error }, search: { ok: res.ok, kind: res.kind || '', status: res.status || 0 } };
  }, seen.cluster);
  ok(!/display link/.test(String(measured.pre.error || '')) && measured.search.kind !== 'forbidden',
    'the page\'s own log-delay measurement is allowed (_field_caps, then the search)', JSON.stringify(measured));
  console.log(`    preflight ${measured.pre.ok ? 'ok' : measured.pre.error || 'fields missing'}; search ${measured.search.ok ? 'answered' : measured.search.kind} ${measured.search.status || ''}`);
  const meta = await asTv({ type: 'CLUSTER_META_GET' });
  ok(meta.ok === true, 'CLUSTER_META_GET is answered (CI / DI / On-Prem on the wall)', JSON.stringify(meta).slice(0, 200));
  // The measurer's own payload, built by the page's own code, kept by the core and read back.
  const shared = await page.evaluate(async (id) => {
    const M = await import('/js/play/measure.js');
    const api = await import('/js/play/api.js');
    const at = Date.now() - 1000;
    const data = M.shareData({ records: [{ device: 'e2e-fw-1', delayMinutes: 45 }, { device: 'e2e-fw-2', delayMinutes: 1 }], truncated: 0 });
    const put = await api.sharePut('delay', id, at, data);
    const got = await api.shareGet('delay', [id]);
    const back = got.ok ? M.fromShare(got.byCluster.get(id)) : null;
    return { put, at, back };
  }, seen.cluster);
  ok(shared.put.ok === true && shared.put.kept === true, 'PLAY_SHARE_PUT keeps the measurer\'s own payload', JSON.stringify(shared.put));
  ok(shared.back && shared.back.measuredAt === shared.at && shared.back.records.length === 2 && shared.back.records[0].device === 'e2e-fw-1',
    'and PLAY_SHARE_GET reads it back as a measurement', JSON.stringify(shared.back));

  /* 4. revoked: the TV says so */
  const gone = await admin({ type: 'PLAY_LINK_REVOKE', id: linkId });
  revoked = !!gone.ok;
  ok(gone.ok && gone.sessionsEnded >= 1, 'PLAY_LINK_REVOKE ended the TV\'s session', JSON.stringify(gone));
  const told = await page.waitForSelector('#display-refused', { timeout: 180000 }).then(() => true).catch(() => false);
  ok(told, 'the TV shows that its link was refused', told ? '' : (await page.evaluate(() => document.body.innerText.slice(0, 300))));
  if (told) console.log(`    "${(await page.textContent('#display-refused')).replace(/\s+/g, ' ').trim().slice(0, 160)}"`);
  const after = await asTv({ type: 'FLEET_STATE' });
  ok(after.ok === false && after.kind === 'unauthenticated', 'and its session is gone', JSON.stringify(after).slice(0, 160));
  ok(!errors.length, 'no uncaught errors on the page', errors.slice(0, 3).join(' | '));
} catch (e) {
  ok(false, 'the run went to the end', String(e && e.message || e));
} finally {
  if (linkId && !revoked) await admin({ type: 'PLAY_LINK_REVOKE', id: linkId }).catch(() => {});
  await admin({ type: 'LOGOUT' }).catch(() => {});
  if (browser) await browser.close();
}

if (failed) { console.log(`play-e2e: ${failed} check(s) failed`); process.exit(1); }
console.log('ok: play-e2e — display link made, the TV shows the Fleet wall, its session shows only Play, and a revoke is told on the TV');
