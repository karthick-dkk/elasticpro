// Certificates and SSH host keys are accepted by default; checking is something a cluster or
// jump host asks for. The UI resolves a cluster's mode before it reaches the core, so the
// default lives here as well as in tls.rs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize, newRawConfig } from '../../ui/js/core/config.js';

const raw = (extra = {}) => ({
  jump_hosts: { jw: { host: 'jump.internal', user: 'u' }, strict: { host: 'j2', user: 'u', host_key: 'verify' } },
  clusters: [
    { name: 'plain', url: 'https://10.0.0.1:9200' },
    { name: 'checked', url: 'https://10.0.0.2:9200', tls: 'auto' },
  ],
  ...extra,
});

test('a cluster without tls accepts any certificate', () => {
  const c = normalize(raw());
  assert.equal(c.clusters.find((x) => x.name === 'plain').tls, 'insecure');
  assert.equal(c.clusters.find((x) => x.name === 'checked').tls, 'auto', 'an explicit choice is kept');
});

test('defaults.tls still applies to clusters that do not say', () => {
  const c = normalize(raw({ defaults: { tls: 'system' } }));
  assert.equal(c.clusters.find((x) => x.name === 'plain').tls, 'system');
});

test('a new config starts with accept-any', () => {
  assert.equal(newRawConfig().defaults.tls, 'insecure');
});

test('a jump host keeps its host_key setting; unset means accept', () => {
  const c = normalize(raw());
  assert.equal(c.jumpHosts.find((j) => j.id === 'jw').hostKey, '');
  assert.equal(c.jumpHosts.find((j) => j.id === 'strict').hostKey, 'verify');
});
