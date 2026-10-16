// Config → Defaults → Certificates = insecure: one switch for every cluster, and one
// notification for everything it let through — never one per cluster.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize } from '../../ui/js/core/config.js';
import { acceptedNotice, acceptedSignature, newSince, noticeToShow, readSeen, writeSeen, SEEN_KEY } from '../../ui/js/core/trust-notice.js';

const raw = (tls) => ({ ...(tls ? { defaults: { tls } } : {}), clusters: [
  { name: 'a', url: 'https://10.0.0.1:9200' }, { name: 'b', url: 'https://10.0.0.2:9200', tls: 'system' }] });

test('checking stays on by default', () => {
  const c = normalize(raw());
  assert.deepEqual(c.clusters.map((x) => x.tls), ['auto', 'system']);
  assert.equal(c.acceptAllCertificates, false);
});

test('defaults.tls insecure is one switch for the core; clusters keep their own setting', () => {
  // Not baked into each cluster: a page loaded while the switch was on must not keep
  // "insecure" on its clusters after an admin turns it off.
  const c = normalize(raw('insecure'));
  assert.equal(c.acceptAllCertificates, true);
  assert.deepEqual(c.clusters.map((x) => x.tls), ['auto', 'system']);
});

const cert = (target, names, fp = target) => ({ kind: 'certificate', target, fingerprint: fp, subject: 'CN=x', reason: 'UnknownIssuer',
  clusters: names.map((n) => ({ id: n, name: n })) });

test('many accepted certificates make one notice', () => {
  const list = [cert('10.0.0.1:9200', ['a']), cert('10.0.0.2:9200', ['b', 'c']),
    { kind: 'host_key', target: 'jw', fingerprint: 'SHA256:x', subject: 'ssh-ed25519', reason: 'not trusted yet', clusters: [] }];
  const n = acceptedNotice(list);
  assert.match(n.message, /2 certificates on 3 clusters and 1 jump-host key/);
  assert.equal(n.detail.length, 3, 'every item named in the one notice');
  assert.equal(acceptedNotice([]), null, 'nothing accepted: no notice');
});

test('it pops up again only when something new joins', () => {
  const one = [cert('10.0.0.1:9200', ['a'])];
  const sig = acceptedSignature(one);
  assert.equal(newSince(sig, one).length, 0, 're-read: nothing new');
  assert.equal(newSince(sig, [...one, cert('10.0.0.2:9200', ['b'])]).length, 1);
  assert.equal(newSince(sig, [cert('10.0.0.1:9200', ['a'], 'rotated')]).length, 1, 'a rotated certificate is new');
});

/* ------- once per distinct set, and nothing when the operator chose insecure ------- */

const memory = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) }; };

test('insecure on purpose: no notice at all, however long the list', () => {
  const list = [cert('10.0.0.1:9200', ['a']), cert('10.0.0.2:9200', ['b'])];
  assert.equal(noticeToShow({ deliberate: true, accepted: list, seenSig: '' }), null);
});

test('the same set is announced once, the minute-later check says nothing', () => {
  const store = memory();
  const list = [cert('10.0.0.1:9200', ['a'])];
  const first = noticeToShow({ deliberate: false, accepted: list, seenSig: readSeen(store) });
  assert.ok(first, 'a set not yet announced is news');
  writeSeen(store, first.sig);
  assert.equal(noticeToShow({ deliberate: false, accepted: list, seenSig: readSeen(store) }), null, 'next 60 s check');
  // A reload is a new page over the same storage.
  assert.equal(noticeToShow({ deliberate: false, accepted: [...list], seenSig: readSeen(store) }), null, 'after a reload');
});

test('a set that grows is announced once more, naming everything', () => {
  const store = memory();
  const one = [cert('10.0.0.1:9200', ['a'])];
  writeSeen(store, acceptedSignature(one));
  const two = [...one, cert('10.0.0.2:9200', ['b'])];
  const n = noticeToShow({ deliberate: false, accepted: two, seenSig: readSeen(store) });
  assert.ok(n);
  assert.equal(n.detail.length, 2);
  writeSeen(store, n.sig);
  assert.equal(noticeToShow({ deliberate: false, accepted: two, seenSig: readSeen(store) }), null);
});

test('nothing accepted, nothing to say; unusable storage only means asking again', () => {
  assert.equal(noticeToShow({ deliberate: false, accepted: [], seenSig: '' }), null);
  const broken = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.equal(readSeen(broken), '');
  assert.doesNotThrow(() => writeSeen(broken, 'x'));
  assert.equal(typeof SEEN_KEY, 'string');
});
