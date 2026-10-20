/**
 * "Related" on an alert: the ±60 minute timeline, the one documented rule for "probably
 * caused by this", and past occurrences — with "No history yet" when there are none.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const url = (p) => pathToFileURL(path.join(ROOT, p)).href;
const R = await import(url('ui/js/core/alert-related.js'));
const H = await import(url('ui/js/core/alert-history.js'));

const MIN = 60000, HOUR = 3600000;
const T0 = Date.parse('2026-10-20T10:00:00');
const cluster = { id: 'c1', name: 'atlas-prod' };
const am = (family, minutesAfter, extra = {}) => ({
  key: `c1:${family}`, clusterId: 'c1', cluster, family, title: family, count: '', detail: '', items: [],
  since: T0 + minutesAfter * MIN, level: 'warning', ...extra,
});

test('a health alert after a disk alert on the same cluster is marked "probably caused by this"', () => {
  const disk = am('disk', 12), health = am('health', 31), ilm = am('ilm', 70);
  const rows = R.relatedFor(disk, [disk, health, ilm], T0 + 2 * HOUR);
  assert.deepEqual(rows.map((r) => r.key), ['c1:disk', 'c1:health', 'c1:ilm']);
  assert.equal(rows[0].self, true);
  assert.equal(rows[1].relation, 'caused-by-this');
  assert.equal(rows[1].deltaText, '19 m later');
  assert.match(rows[1].why, /high watermark/);
  assert.equal(rows[2].relation, 'caused-by-this', 'ILM errors 58 min later are still inside the hour');
  assert.deepEqual(rows.map((r) => r.when).slice(0, 2), ['10:12', '10:31']);
});

test('only alerts within an hour are listed, and only known cause pairs are marked', () => {
  const disk = am('disk', 0);
  const near = am('ilm', 59), far = am('ilm', 61, { key: 'c1:ilm2', family: 'ilm' }), unrelated = am('slm-mode', 10);
  const rows = R.relatedFor(disk, [disk, near, far, unrelated]);
  assert.deepEqual(rows.map((r) => r.key), ['c1:disk', 'c1:slm-mode', 'c1:ilm']);
  assert.equal(rows.find((r) => r.key === 'c1:slm-mode').relation, null, 'in the window but no documented cause: listed, nothing claimed');
  assert.equal(rows.find((r) => r.key === 'c1:ilm').relation, 'caused-by-this');
});

test('the cause must come first: a health alert that started BEFORE the disk alert is not caused by it', () => {
  const disk = am('disk', 30), health = am('health', 10);
  const rows = R.relatedFor(disk, [disk, health]);
  assert.equal(rows.find((r) => r.key === 'c1:health').relation, null);
  // seen from the health alert, the earlier disk alert is a known cause
  const back = R.relatedFor(health, [disk, health]);
  assert.equal(back.find((r) => r.key === 'c1:disk').relation, null, 'disk started after health here');
  const disk2 = am('disk', 5), health2 = am('health', 25);
  assert.equal(R.relatedFor(health2, [disk2, health2]).find((r) => r.key === 'c1:disk').relation, 'cause-of-this');
});

test('two alerts first seen together when the page opened say nothing about which came first', () => {
  const disk = am('disk', 0, { approxSince: true }), health = am('health', 0, { approxSince: true });
  const rows = R.relatedFor(disk, [disk, health]);
  assert.equal(rows[1].relation, null, 'simultaneous first sightings are not causation');
  assert.match(rows[1].deltaText, /first seen at about the same time; the order is not known/);
  // the same alerts seen to start 19 minutes apart, both with known starts, are
  const d2 = am('disk', 0), h2 = am('health', 19);
  assert.equal(R.relatedFor(d2, [d2, h2])[1].relation, 'caused-by-this');
  // one known and one approximate: still not claimed
  assert.equal(R.relatedFor(d2, [d2, am('health', 19, { approxSince: true })])[1].relation, null);
  // exactly simultaneous with known starts: no order, no claim
  assert.equal(R.relatedFor(d2, [d2, am('health', 0)])[1].relation, null);
});

test('other clusters are never related', () => {
  const disk = am('disk', 0);
  const other = am('health', 5, { key: 'c2:health', clusterId: 'c2' });
  assert.deepEqual(R.relatedFor(disk, [disk, other]).map((r) => r.key), ['c1:disk']);
});

test('slm-stale after a repository failure; slm-stale after SLM stopped; health after a master change', () => {
  assert.equal(R.relatedFor(am('repo', 0), [am('repo', 0), am('slm-stale', 20)])[1].relation, 'caused-by-this');
  assert.equal(R.relatedFor(am('slm-mode', 0), [am('slm-mode', 0), am('slm-stale', 20)])[1].relation, 'caused-by-this');
  assert.equal(R.relatedFor(am('master-changed', 0), [am('master-changed', 0), am('health', 3)])[1].relation, 'caused-by-this');
  assert.equal(R.isKnownCause('repo', 'slm-fail'), true);
  assert.equal(R.isKnownCause('health', 'disk'), false, 'the table has a direction');
});

test('the same input gives the same answer, in any order of the siblings', () => {
  const list = [am('disk', 0), am('health', 5), am('ilm', 5, { key: 'c1:ilm' }), am('slm-mode', 5)];
  const a = R.relatedFor(list[0], list, T0 + HOUR);
  const b = R.relatedFor(list[0], [...list].reverse(), T0 + HOUR);
  assert.deepEqual(a.map((r) => [r.key, r.relation]), b.map((r) => [r.key, r.relation]));
});

/* -------------------------------- history -------------------------------- */

const ep = (start, hours, extra = {}) => ({ key: 'c1:disk', clusterId: 'c1', rule: 'disk', start, end: start + hours * HOUR, level: 'critical', unsure: false, approx: false, ...extra });

test('no past occurrence: "No history yet for this alert on <cluster>" — never zero', () => {
  const h = R.historyFor(am('disk', 0), [], [], { since: T0 - 3 * HOUR, now: T0 });
  assert.equal(h.empty, true);
  assert.equal(h.emptyText, 'No history yet for this alert on atlas-prod');
  assert.equal(h.count, 0);
  assert.match(h.sinceText, /watching from/);
  assert.deepEqual(h.lines, []);
});

test('past occurrences: count in 30 days, the last, how long it lasted, and the note left then', () => {
  const d = (n) => T0 - n * 24 * HOUR;
  const episodes = [ep(d(8), 2), ep(d(15), 5), ep(d(22), 1)];
  const notes = [
    { key: 'c1:disk', notes: [{ text: 'deleted logs-* older than 30 days, rollover fixed', by: 'admin', ts: d(8) + 3600000 }] },
    { key: 'c1:disk', notes: [{ text: 'older note', by: 'x', ts: d(15) + 60000 }] },
    { key: 'c1:ilm', notes: [{ text: 'someone else', by: 'y', ts: d(8) + 60000 }] },
  ];
  const h = R.historyFor(am('disk', 0), episodes, notes, { now: T0 });
  assert.equal(h.empty, false);
  assert.equal(h.count, 4, 'three before, and this one');
  assert.match(h.lines[0], /Seen 4 times in 30 days on this cluster, including now/);
  assert.match(h.lines[1], /cleared after 2 h/);
  assert.deepEqual([h.note.by, h.note.text], ['admin', 'deleted logs-* older than 30 days, rollover fixed']);
});

test('an end found long after the last sighting says so rather than quoting a duration', () => {
  const h = R.historyFor(am('disk', 0), [ep(T0 - 5 * 24 * HOUR, 3, { unsure: true })], [], { now: T0 });
  assert.match(h.lines[1], /was closed when it cleared, so how long it lasted is not known/);
  assert.ok(!/cleared after/.test(h.lines[1]));
});

test('a note from another alert, or from long before, is not "the note from that time"', () => {
  const e = ep(T0 - 5 * 24 * HOUR, 2);
  const h = R.historyFor(am('disk', 0), [e], [
    { key: 'c1:disk', notes: [{ text: 'too early', by: 'a', ts: e.start - 1 }] },
    { key: 'c1:disk', notes: [{ text: 'too late', by: 'a', ts: e.end + 7 * HOUR }] },
  ], { now: T0 });
  assert.equal(h.note, null);
});

/* -------------------------- the log it reads from --------------------------- */

function memStorage() { let v = null; return { get: () => v, set: (s) => { v = s; }, peek: () => v }; }
const obs = (key, items = ['a'], extra = {}) => ({ key, clusterId: key.split(':')[0], rule: key.split(':')[1], level: 'warning', items: items.map((id) => ({ id })), ...extra });

test('an episode opens on first sight, survives a blip, and closes after the grace', () => {
  const st = memStorage();
  const log = H.createHistory({ storage: st });
  log.observe([], T0);                                 // the page opens with nothing wrong
  log.observe([obs('c1:disk')], T0 + MIN);
  assert.equal(log.startOf('c1:disk'), T0 + MIN);
  assert.equal(log.approxStart('c1:disk'), false, 'seen appear, not already there');
  log.observe([], T0 + 2 * MIN);                       // one refresh without it
  log.observe([obs('c1:disk')], T0 + 3 * MIN);         // and back: the same episode
  assert.equal(log.startOf('c1:disk'), T0 + MIN);
  log.observe([], T0 + 4 * MIN);
  assert.equal(log.episodes('c1:disk', T0 + 5 * MIN).length, 0, 'not over yet');
  log.observe([], T0 + 3 * MIN + H.CLOSE_AFTER_MS + 1);
  const [e] = log.episodes('c1:disk', T0 + HOUR);
  assert.equal(e.start, T0 + MIN);
  assert.equal(e.end, T0 + 3 * MIN);
  assert.equal(e.unsure, false);
  assert.equal(log.startOf('c1:disk'), null);
});

test('what was already raised when the page opened has an approximate start', () => {
  const log = H.createHistory({ storage: memStorage() });
  log.observe([obs('c1:disk')], T0);
  assert.equal(log.approxStart('c1:disk'), true);
  // a time the alert knows for itself replaces it
  log.observe([obs('c1:disk', ['a'], { startHint: T0 - 2 * HOUR })], T0 + MIN);
  assert.equal(log.startOf('c1:disk'), T0 - 2 * HOUR);
  assert.equal(log.approxStart('c1:disk'), false);
});

test('an episode ended while the app was closed is "unsure", and the log is kept across loads', () => {
  const st = memStorage();
  const a = H.createHistory({ storage: st });
  a.observe([obs('c1:disk')], T0);
  a.observe([obs('c1:disk')], T0 + MIN);
  const b = H.createHistory({ storage: st });          // the next day's page load
  b.observe([], T0 + 20 * HOUR);
  const [e] = b.episodes('c1:disk', T0 + 21 * HOUR);
  assert.equal(e.unsure, true);
  assert.equal(e.end, T0 + MIN, 'ends at the last time it was seen');
  assert.equal(b.since(), T0, 'the log says how far back it goes');
});

test('items are remembered by first sight, and a new one is new', () => {
  const log = H.createHistory({ storage: memStorage() });
  log.observe([], T0);
  log.observe([obs('c1:disk', ['n1'])], T0 + MIN);
  log.observe([obs('c1:disk', ['n1', 'n2'])], T0 + 30 * MIN);
  assert.equal(log.itemFirstSeen('c1:disk', 'n1'), T0 + MIN);
  assert.equal(log.itemFirstSeen('c1:disk', 'n2'), T0 + 30 * MIN);
  assert.equal(log.itemFirstSeen('c1:disk', 'zz'), null);
});

test('episodes older than the retention are dropped', () => {
  const log = H.createHistory({ storage: memStorage(), retentionDays: 30 });
  log.observe([], T0);
  log.observe([obs('c1:disk')], T0 + MIN);
  log.observe([], T0 + 10 * MIN);
  log.observe([], T0 + 31 * 24 * HOUR);
  assert.equal(log.episodes('c1:disk', T0 + 31 * 24 * HOUR).length, 0);
});

test('a storage that throws or holds rubbish does not break the log', () => {
  const bad = { get: () => { throw new Error('no'); }, set: () => { throw new Error('no'); } };
  const log = H.createHistory({ storage: bad });
  assert.doesNotThrow(() => log.observe([obs('c1:disk')], T0));
  const junk = H.createHistory({ storage: { get: () => '{not json', set() {} } });
  assert.doesNotThrow(() => junk.observe([obs('c1:disk')], T0));
  assert.equal(junk.startOf('c1:disk'), T0);
});
