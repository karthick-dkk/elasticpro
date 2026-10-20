/**
 * Every alert leads somewhere, and says how to fix it. A rule added to ALERT_RULES without a
 * "Go to" target or a playbook fails here, rather than shipping an alert with no way on.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const url = (p) => pathToFileURL(path.join(ROOT, p)).href;
const { ALERT_RULES, pageForProblem } = await import(url('ui/js/core/alert-rules.js'));
const GOTO = await import(url('ui/js/core/alert-goto.js'));
const PB = await import(url('ui/js/core/alert-playbooks.js'));
const focus = await import(url('ui/js/core/focus.js'));
const labels = await import(url('ui/js/core/page-labels.js'));
const G = await import(url('ui/js/core/alert-groups.js'));

/** The page ids app.js really has — its PAGES list is the one definition. */
const appSrc = fs.readFileSync(path.join(ROOT, 'ui/js/app.js'), 'utf8');
const PAGE_IDS = [...appSrc.slice(appSrc.indexOf('const PAGES = ['), appSrc.indexOf('];', appSrc.indexOf('const PAGES = [')))
  .matchAll(/\{ id: '([a-z]+)'/g)].map((m) => m[1]);

const cluster = { id: 'c1', name: 'prod', url: 'http://c1' };
const fake = (rule, extra = {}) => G.mergeAlerts([{ key: `c1:${rule.id}`, level: rule.level, cluster, title: `prod ${rule.id}`, detail: 'd', ...extra }],
  { defaults: { diskWarnPercent: 85, diskCritPercent: 90 } })[0];

test('the page ids are read from app.js', () => {
  assert.ok(PAGE_IDS.length >= 10 && PAGE_IDS.includes('shards') && PAGE_IDS.includes('volume'), PAGE_IDS.join());
});

test('every rule has a Go to target, on a page that exists', () => {
  assert.deepEqual(GOTO.rulesWithoutTarget(), [], 'rules with no entry in FOCUS');
  for (const rule of ALERT_RULES) {
    const g = GOTO.gotoFor(fake(rule));
    assert.ok(PAGE_IDS.includes(g.page), `${rule.id} leads to ${g.page}, which is not a page`);
    assert.equal(g.page, pageForProblem(rule.id, ''), `${rule.id}: the page is the rule's own, not a second answer`);
    assert.equal(g.page, rule.page, `${rule.id}: the page is the rule's registry page`);
    assert.equal(g.clusterId, 'c1');
    assert.equal(g.external, null);
  }
});

test('where each rule lands on its page', () => {
  const at = (id, extra) => GOTO.gotoFor(fake(ALERT_RULES.find((r) => r.id === id), extra));
  assert.deepEqual([at('health').page, at('health').focus], ['shards', { section: 'unassigned' }]);
  for (const id of ['disk', 'disk-balance', 'disk-unaccounted', 'capacity']) assert.equal(at(id).page + ':' + at(id).focus.section, 'shards:disk');
  for (const id of ['no-master', 'master-changed']) assert.equal(at(id).focus.section, 'nodes');
  assert.deepEqual([at('ilm').page, at('ilm').focus.ilm], ['indices', true]);
  for (const id of ['slm-mode', 'slm-fail', 'slm-stale']) assert.deepEqual([at(id).page, at(id).focus.view, at(id).focus.section], ['snapshots', 'summary', 'policies']);
  assert.deepEqual([at('repo').page, at('repo').focus.section], ['snapshots', 'repos']);
  assert.deepEqual([at('log-delay').page, at('log-delay').focus.view], ['logs', 'delay']);
  assert.equal(at('unreachable').page, 'overview');
  assert.deepEqual(at('unreachable').focus, { section: 'unreachable', cluster: 'c1' }, 'Clusters page: that cluster\'s card');
  // The volume rule leads to the Volume report, no longer the Clusters page.
  assert.equal(at('volume').page, 'volume');
  const vol = G.mergeAlerts([{ key: 'c1:volume:host.name:p7', level: 'warning', cluster, title: 'prod: host.name "p7" volume up 500%' }], {})[0];
  assert.deepEqual(GOTO.gotoFor(vol).focus, { field: 'host.name' });
  const auto = G.mergeAlerts([{ key: 'c1:automation:my-rule', level: 'warning', cluster, title: 'My rule', detail: '' }], {})[0];
  assert.deepEqual([GOTO.gotoFor(auto).page, GOTO.gotoFor(auto).focus], ['automation', { rule: 'my-rule' }]);
});

test('an item narrows the target: this node, this index', () => {
  const data = { disk: { nodes: [{ node: 'hot-1', 'disk.used': '92', 'disk.total': '100' }] }, ilmErrors: { 'logs-1': {} } };
  const disk = G.mergeAlerts([{ key: 'c1:disk', level: 'critical', cluster, title: 't', diskPercent: 92 }], { defaults: { diskWarnPercent: 85, diskCritPercent: 90 }, data: () => data })[0];
  assert.deepEqual(GOTO.gotoFor(disk, disk.items[0]).focus, { section: 'disk', node: 'hot-1' });
  const ilm = G.mergeAlerts([{ key: 'c1:ilm', level: 'warning', cluster, title: 't' }], { data: () => data })[0];
  assert.deepEqual(GOTO.gotoFor(ilm, ilm.items[0]).focus, { ilm: true, index: 'logs-1' });
});

test('a Zabbix problem opens in Zabbix, not in a page here', () => {
  const m = fake(ALERT_RULES[0], { problemUrl: 'https://zbx.example/tr_events.php?eventid=1' });
  const g = GOTO.gotoFor(m);
  assert.equal(g.external, 'https://zbx.example/tr_events.php?eventid=1');
  assert.equal(g.page, null);
});

test('the label is the one the tab says — from the page list, so a rename flows through', () => {
  assert.equal(labels.pageLabel('shards'), 'shards', 'before the shell registers, the id stands in');
  labels.registerPages([{ id: 'snapshots', label: 'Snapshots' }, { id: 'shards', label: 'Nodes & shards' }]);
  const g = GOTO.gotoFor(fake(ALERT_RULES.find((r) => r.id === 'slm-fail')));
  assert.equal(g.label, 'Snapshots');
  labels.registerPages([{ id: 'snapshots', label: 'Snapshots & SLM' }]);
  assert.equal(GOTO.gotoFor(fake(ALERT_RULES.find((r) => r.id === 'slm-fail'))).label, 'Snapshots & SLM');
  assert.ok(!/Snapshots/.test(fs.readFileSync(path.join(ROOT, 'ui/js/pages/alerts.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')),
    'alerts.js must not hard-code a page name');
});

test('a focus hint is taken once, for its page, and expires', () => {
  focus.setFocus('shards', { section: 'disk' }, 1000);
  assert.equal(focus.takeFocus('indices', 1001), null, 'another page does not take it');
  assert.deepEqual(focus.takeFocus('shards', 1001), { section: 'disk' });
  assert.equal(focus.takeFocus('shards', 1002), null, 'once');
  focus.setFocus('shards', { section: 'disk' }, 1000);
  assert.equal(focus.takeFocus('shards', 1000 + focus.FOCUS_TTL_MS + 1), null, 'a navigation that never arrived leaves nothing behind');
});

/* ------------------------------- playbooks ------------------------------- */

test('every rule has a playbook with a cause and steps', () => {
  assert.deepEqual(PB.rulesWithoutPlaybook(), []);
  for (const rule of ALERT_RULES) {
    const pb = PB.playbookFor(fake(rule), { defaults: { snapshotStaleHours: 24 }, watermarks: { assumed: true } });
    assert.ok(pb.cause && pb.cause.length > 20, `${rule.id}: cause`);
    assert.ok(pb.steps.length >= 2, `${rule.id}: steps`);
    for (const s of pb.steps) {
      assert.ok(s.text, `${rule.id}: a step has words`);
      for (const l of s.links || []) assert.ok(PAGE_IDS.includes(l.page), `${rule.id}: link to ${l.page}`);
      if (s.request) {
        assert.match(s.request.method, /^(GET|POST|PUT|DELETE)$/);
        assert.ok(s.request.path.startsWith('/'), `${rule.id}: ${s.request.path}`);
        // a request that is not a plain read must say it writes
        if (s.request.method !== 'GET') assert.equal(s.request.write, true, `${rule.id}: ${s.request.method} ${s.request.path} must be marked as a write`);
        else assert.ok(!s.request.write);
      }
    }
  }
});

test('a playbook sends nothing: it prepares requests as data and never calls the console', () => {
  const src = fs.readFileSync(path.join(ROOT, 'ui/js/core/alert-playbooks.js'), 'utf8');
  assert.ok(!/\bfetch\(|bridge\(|\.json\(|navigateTo|from '[^']*\/(es|transport|state)\.js'/.test(src.replace(/\/\*[\s\S]*?\*\//g, '')), 'playbooks are text and data');
});

test('disk thresholds come from the cluster\'s watermarks when it reports them, else say "the cluster\'s"', () => {
  const m = fake(ALERT_RULES.find((r) => r.id === 'disk'));
  const known = PB.playbookFor(m, { watermarks: { low: 85, high: 90, flood: 95, assumed: false } });
  assert.match(known.cause, /high watermark \(90%\)/);
  assert.match(known.cause, /flood stage \(95%\)/);
  const unknown = PB.playbookFor(m, { watermarks: { low: 85, high: 90, flood: 95, assumed: true } });
  assert.match(unknown.cause, /the cluster's high watermark/);
  assert.ok(!/90%|95%/.test(unknown.cause), 'a default is not quoted as if it were measured');
});

test('a playbook points at what is open on the same cluster', () => {
  const disk = fake(ALERT_RULES.find((r) => r.id === 'disk'));
  const ilm = fake(ALERT_RULES.find((r) => r.id === 'ilm'));
  const withIlm = PB.playbookFor(disk, { siblings: new Map([['ilm', ilm]]) });
  assert.ok(withIlm.steps.some((s) => /stuck in ILM/.test(s.text)));
  assert.ok(!PB.playbookFor(disk, { siblings: new Map() }).steps.some((s) => /stuck in ILM/.test(s.text)));
});

test('an alert of no known rule gets a generic playbook that says so', () => {
  const m = G.mergeAlerts([{ key: 'c1:mystery', level: 'warning', cluster, title: 'x' }], {})[0];
  assert.match(PB.playbookFor(m).cause, /no written playbook/);
});
