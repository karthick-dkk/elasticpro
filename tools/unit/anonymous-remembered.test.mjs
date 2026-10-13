/** "Continue without credentials" is remembered across page loads: the core says which
 *  clusters it holds no credential for on purpose, and the page stops asking for one. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const { state, markServerHeld, markServerAnonymous, clustersNeedingCredential, configFileName } =
  await import(pathToFileURL(path.join(ROOT, 'ui/js/core/state.js')).href);

const fresh = () => {
  // What a hosted page load builds from a config file that holds no password.
  state.config = { clusters: [
    { id: 'open', name: 'open', url: 'http://es-open:9200', enabled: true, needsCred: true, anonymous: false, credSource: 'none', source: 'file' },
    { id: 'secured', name: 'secured', url: 'http://es:9200', enabled: true, needsCred: true, anonymous: false, credSource: 'none', source: 'file' },
  ], fileMeta: { name: 'config_cluster.json' } };
};

test('a cluster the core connected without a credential is not asked for one again', () => {
  fresh();
  assert.deepEqual(clustersNeedingCredential().map((c) => c.id), ['open', 'secured'], 'before the core answers, both need one');
  markServerHeld(['secured']);          // an admin typed one for this cluster earlier
  markServerAnonymous(['open']);        // and chose "Continue without credentials" for this one
  assert.deepEqual(clustersNeedingCredential(), [], 'nothing left to ask for');
  const open = state.config.clusters.find((c) => c.id === 'open');
  assert.equal(open.anonymous, true);
  assert.equal(open.credSource, 'none', 'anonymous is not a credential');
});

test('a reply without the field, or an unknown id, changes nothing', () => {
  fresh();
  markServerAnonymous(undefined); markServerAnonymous(['nope']);
  assert.equal(clustersNeedingCredential().length, 2);
});

test('the prompt names the loaded config file, not a file that is not there', () => {
  fresh();
  assert.equal(configFileName(), 'config_cluster.json');
  state.config = null;
  assert.equal(configFileName(), 'The config file');
});
