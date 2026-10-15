// Config → Defaults → Certificates = insecure: one switch for every cluster, and one
// notification for everything it let through — never one per cluster.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize } from '../../ui/js/core/config.js';
import { acceptedNotice, acceptedSignature, newSince } from '../../ui/js/core/trust-notice.js';

const raw = (tls) => ({ ...(tls ? { defaults: { tls } } : {}), clusters: [
  { name: 'a', url: 'https://10.0.0.1:9200' }, { name: 'b', url: 'https://10.0.0.2:9200', tls: 'system' }] });

test('checking stays on by default', () => {
  const c = normalize(raw());
  assert.deepEqual(c.clusters.map((x) => x.tls), ['auto', 'system']);
  assert.equal(c.acceptAllCertificates, false);
});

test('defaults.tls insecure applies to every cluster, whatever its own tls', () => {
  const c = normalize(raw('insecure'));
  assert.deepEqual(c.clusters.map((x) => x.tls), ['insecure', 'insecure']);
  assert.equal(c.acceptAllCertificates, true);
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
