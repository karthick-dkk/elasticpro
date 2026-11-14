/** A pasted request recognised — core/console-paste.js: method, path and body out of one text. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const P = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/console-paste.js')).href);

test('method and path on one line, any case; the path gets its slash', () => {
  assert.deepEqual(P.parseRequestText('post _snapshot/es_9/execute'), { method: 'POST', path: '/_snapshot/es_9/execute', body: '', form: 'line' });
  assert.deepEqual(P.parseRequestText('GET /_cat/indices?v&s=index'), { method: 'GET', path: '/_cat/indices?v&s=index', body: '', form: 'line' });
  assert.equal(P.parseRequestText('  Delete\tmy-index ').method, 'DELETE');
  assert.equal(P.parseRequestText('head /my-index').method, 'HEAD');
  assert.equal(P.parseRequestText('patch /x').method, 'PATCH');
});

test('a whole URL loses its scheme and host: the console sends to the chosen cluster', () => {
  assert.equal(P.parseRequestText('GET http://es-01.corp:9200/_cluster/health?pretty').path, '/_cluster/health?pretty');
  assert.equal(P.parseRequestText('GET https://10.0.0.1:9200').path, '/');
  assert.equal(P.normalisePath('_cat/health'), '/_cat/health');
  assert.equal(P.normalisePath('/already'), '/already');
});

test('Kibana Dev Tools style: the body follows on the next lines and is formatted when it is JSON', () => {
  const r = P.parseRequestText('POST _snapshot/es_9/_restore\n{ "indices": "logs-*",\n"ignore_unavailable": true }\n');
  assert.equal(r.method, 'POST'); assert.equal(r.path, '/_snapshot/es_9/_restore');
  assert.equal(r.body, '{\n  "indices": "logs-*",\n  "ignore_unavailable": true\n}');
  // Windows line ends, and a body that is not JSON (an NDJSON bulk) kept as pasted.
  assert.equal(P.parseRequestText('PUT /x\r\n{"a":1}').body, '{\n  "a": 1\n}');
  const bulk = '{"index":{"_index":"t"}}\n{"f":1}';
  assert.equal(P.parseRequestText(`POST _bulk\n${bulk}`).body, bulk);
});

test('what is not a request is left alone', () => {
  for (const t of ['', '   ', '_cat/indices', '/_cluster/health', 'GET', 'POST ', 'BREW /tea', 'get', '{ "query": {} }', 'GETTING started', 'posted /x\n{}'.slice(0, 6)]) {
    assert.equal(P.parseRequestText(t), null, JSON.stringify(t));
  }
  // A JSON body alone (what a person pastes into the Query editor) is not a request.
  assert.equal(P.parseRequestText('{\n  "size": 0\n}'), null);
});

test('curl: -X, the URL, -d; POST when only -d is given; @file bodies left out', () => {
  const r = P.parseRequestText("curl -XPOST 'http://host:9200/_snapshot/x/_restore' -H 'Content-Type: application/json' -d '{\"indices\":\"a\"}'");
  assert.deepEqual(r, { method: 'POST', path: '/_snapshot/x/_restore', body: '{\n  "indices": "a"\n}', form: 'curl' });
  assert.deepEqual(P.parseRequestText('curl -s -k -u elastic:pw "https://es:9200/_cat/health?v"'),
    { method: 'GET', path: '/_cat/health?v', body: '', form: 'curl' });
  assert.equal(P.parseRequestText('curl -X DELETE http://es:9200/my-index').method, 'DELETE');
  assert.equal(P.parseRequestText('curl --request PUT --url http://es:9200/my-index --data-raw \'{"settings":{}}\'').path, '/my-index');
  const d = P.parseRequestText('curl http://es:9200/_bulk --data-binary @req.json');
  assert.equal(d.method, 'POST'); assert.equal(d.body, '');
  // Line continuations and a bare host:port/path, as copied from a shell.
  const c = P.parseRequestText('curl -X POST \\\n  localhost:9200/_search \\\n  -d \'{"size":1}\'');
  assert.equal(c.path, '/_search'); assert.equal(c.body, '{\n  "size": 1\n}');
  assert.equal(P.parseRequestText('curl -s --version'), null, 'a curl with no address is not a request');
});

test('the label names what was recognised, once', () => {
  assert.equal(P.recognisedLabel({ method: 'POST', path: '/_snapshot/es_9/execute', body: '' }), 'Recognised POST /_snapshot/es_9/execute');
  assert.equal(P.recognisedLabel({ method: 'PUT', path: '/x', body: '{}' }), 'Recognised PUT /x with a body');
});
