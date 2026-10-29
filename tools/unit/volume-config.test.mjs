/**
 * The volume settings (docs/VOLUME.md): built-in values, config.txt folded in per sub-key,
 * the legacy volumeFields conversion, override diffing, validation and the generated text.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const V = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/volume-config.js')).href);

test('the built-in values are the contract', () => {
  const d = V.VOLUME_DEFAULTS;
  assert.equal(d.indexFormat, 'logstash-*-YYYY.MM.DD');
  assert.deepEqual(d.tag, ['tag1', 'labels.tag1', 'tags']);
  assert.deepEqual(d.eventSize, ['event_logsize']);
  assert.deepEqual(d.extra, { name: 'Dataset', fields: ['event.dataset', 'log_type'] });
  assert.equal(d.sizeBasis, 'primary');
  assert.equal(d.topValues, 25);
  assert.equal(d.keepMonths, 13);
  assert.equal(d.collectAt, '06:00');
  assert.deepEqual(V.validateVolume(d), [], 'the built-ins must validate');
});

test('cloneVolume is a copy, not the shared object', () => {
  const c = V.cloneVolume();
  c.tag.push('x');
  assert.equal(V.VOLUME_DEFAULTS.tag.length, 3);
});

test('a managed name replaces one sub-key and not the object', () => {
  const { volume, locked } = V.foldManaged(V.cloneVolume(), { volumeTopValues: '50', volumeTag: 'a, b', volumeExtraName: 'Kind' });
  assert.equal(volume.topValues, 50);
  assert.deepEqual(volume.tag, ['a', 'b']);
  assert.equal(volume.extra.name, 'Kind');
  assert.deepEqual(volume.extra.fields, ['event.dataset', 'log_type'], 'the sibling sub-key survives');
  assert.equal(volume.keepMonths, 13);
  assert.deepEqual([...locked].sort(), ['extra.name', 'tag', 'topValues']);
});

test('every VOLUME.md managed name and config.txt key is mapped', () => {
  const managed = V.VOLUME_KEYS.map((k) => k.managed);
  assert.deepEqual(managed, ['volumeIndexFormat', 'volumeTag', 'volumeForwarder', 'volumeSourceHost', 'volumeSourceIp',
    'volumeEventSize', 'volumeSubSize', 'volumeExtraName', 'volumeExtraFields', 'volumeSizeBasis', 'volumeTopValues',
    'volumeKeepMonths', 'volumeCollectAt']);
  assert.ok(V.VOLUME_KEYS.every((k) => /^UI_VOLUME_[A-Z_]+$/.test(k.env)));
});

test('effective: file over built-in, config.txt over file', () => {
  const rd = { volume: { tag: ['t'], topValues: 10 } };
  const v = V.effectiveVolume(rd, { volumeTopValues: 40 });
  assert.deepEqual(v.tag, ['t']);
  assert.equal(v.topValues, 40, 'config.txt wins');
  assert.equal(v.keepMonths, 13);
});

test('wrong shapes in a hand-edited file are ignored, not trusted', () => {
  const v = V.mergeVolume(V.VOLUME_DEFAULTS, { tag: [], topValues: 'lots', extra: 'x', sizeBasis: null });
  assert.deepEqual(v.tag, V.VOLUME_DEFAULTS.tag, 'an empty list keeps the default');
  assert.ok(Number.isNaN(v.topValues), 'a bad number reaches validation rather than being hidden');
  assert.deepEqual(v.extra, V.VOLUME_DEFAULTS.extra);
});

test('legacy volumeFields convert as VOLUME.md says', () => {
  const p = V.legacyToVolume(['tag1', 'fwd_tag', 'fwdtag', 'src_hostname', 'src_ip', 'log_type', 'region']);
  assert.deepEqual(p, { tag: ['tag1'], forwarder: ['fwd_tag', 'fwdtag'], sourceHost: ['src_hostname'], sourceIp: ['src_ip'], extra: { fields: ['log_type', 'region'] } });
  const v = V.fileVolume({ volumeFields: 'tag1, region' });
  assert.deepEqual(v.tag, ['tag1']);
  assert.deepEqual(v.extra.fields, ['region']);
  assert.equal(v.extra.name, 'Dataset');
  assert.deepEqual(v.sourceHost, V.VOLUME_DEFAULTS.sourceHost, 'rows with no legacy name keep the built-in');
});

test('legacy is read only when no volume is set', () => {
  assert.deepEqual(V.fileVolume({ volumeFields: ['x'], volume: { tag: ['t'] } }).extra.fields, V.VOLUME_DEFAULTS.extra.fields);
  assert.deepEqual(V.fileVolume({ volumeFields: ['x'], volume: { overrides: { a: { tag: ['t'] } } } }).extra.fields, ['x'], 'overrides alone is not a setting');
});

test('first save writes volume and drops the legacy list from defaults', () => {
  const d = V.applyDefaults({ readOnly: true, volumeFields: ['tag1'] }, V.fileVolume({ volumeFields: ['tag1'] }));
  assert.equal(d.volumeFields, undefined);
  assert.equal(d.readOnly, true);
  assert.deepEqual(d.volume.tag, ['tag1']);
});

test('a managed key is never written, and an existing file value is kept', () => {
  const vals = V.effectiveVolume({}, { volumeTopValues: 99, volumeTag: 'm' });
  const locked = new Set(['topValues', 'tag']);
  const d = V.applyDefaults({ volume: { tag: ['own'] } }, vals, locked);
  assert.equal(d.volume.topValues, undefined);
  assert.deepEqual(d.volume.tag, ['own']);
  assert.equal(d.volume.keepMonths, 13);
});

test('saving defaults keeps the overrides', () => {
  const d = V.applyDefaults({ volume: { overrides: { a: { tag: ['t'] } } } }, V.cloneVolume());
  assert.deepEqual(d.volume.overrides, { a: { tag: ['t'] } });
});

test('an override saves only what differs from the defaults', () => {
  const defaults = V.cloneVolume();
  const vals = { forwarder: ['fwdtag'], tag: defaults.tag, topValues: 25, extra: { name: 'Dataset', fields: ['log_type'] } };
  assert.deepEqual(V.diffOverride(vals, defaults), { forwarder: ['fwdtag'], extra: { fields: ['log_type'] } });
  assert.deepEqual(V.diffOverride({}, defaults), {}, 'empty is inherit');
  assert.deepEqual(V.diffOverride({ topValues: 40 }, defaults, new Set(['topValues'])), {}, 'locked keys never override');
});

test('applyOverride sets, replaces and removes one cluster, and tidies up', () => {
  const defaults = V.cloneVolume();
  let d = V.applyOverride({}, 'prod', { forwarder: ['fwdtag'] }, defaults);
  assert.deepEqual(d.volume.overrides, { prod: { forwarder: ['fwdtag'] } });
  d = V.applyOverride(d, 'dev', { keepMonths: 6 }, defaults);
  assert.deepEqual(Object.keys(d.volume.overrides).sort(), ['dev', 'prod']);
  d = V.applyOverride(d, 'prod', {}, defaults);
  assert.deepEqual(Object.keys(d.volume.overrides), ['dev']);
  d = V.applyOverride(d, 'dev', { keepMonths: 13 }, defaults);
  assert.equal(d.volume, undefined, 'the last override gone leaves no empty volume block');
  assert.deepEqual(V.overrideIds({ volume: { overrides: { a: { tag: ['t'] }, b: {} } } }), ['a']);
});

test('an override save converts a legacy list, so the file never holds both', () => {
  const d = V.applyOverride({ volumeFields: ['tag1'] }, 'prod', { keepMonths: 6 }, V.cloneVolume());
  assert.equal(d.volumeFields, undefined);
  assert.deepEqual(d.volume.tag, ['tag1']);
  assert.deepEqual(d.volume.overrides, { prod: { keepMonths: 6 } });
});

test('validation: index format, field names, numbers, time', () => {
  const ok = V.cloneVolume();
  assert.deepEqual(V.validateVolume(ok), []);
  assert.equal(V.validateVolume({ ...ok, indexFormat: 'logstash-*' }).length, 1);
  assert.equal(V.validateVolume({ ...ok, indexFormat: 'logstash-YYYY.MM.DD' }).length, 1);
  assert.equal(V.validateVolume({ ...ok, tag: ['good', 'bad name'] }).length, 1);
  assert.equal(V.validateVolume({ ...ok, tag: [] }).length, 1, 'a row needs a field');
  assert.deepEqual(V.validateVolume({ ...ok, tag: ['@timestamp', 'a-b_c.d'] }), []);
  assert.equal(V.validateVolume({ ...ok, topValues: 4 }).length, 1);
  assert.equal(V.validateVolume({ ...ok, topValues: 2.5 }).length, 1);
  assert.equal(V.validateVolume({ ...ok, keepMonths: 37 }).length, 1);
  assert.equal(V.validateVolume({ ...ok, collectAt: '6:00' }).length, 1);
  assert.equal(V.validateVolume({ ...ok, collectAt: '24:00' }).length, 1);
  assert.equal(V.validateVolume({ ...ok, sizeBasis: 'weird' }).length, 1);
  assert.equal(V.validateVolume({ ...ok, extra: { name: ' ', fields: ['a'] } }).length, 1);
});

test('a partial (override) volume is checked only where it speaks', () => {
  assert.deepEqual(V.validateVolume({}, { partial: true }), []);
  assert.deepEqual(V.validateVolume({ forwarder: ['fwdtag'] }, { partial: true }), []);
  assert.equal(V.validateVolume({ forwarder: ['no good'] }, { partial: true }).length, 1);
});

test('the YAML block and the config.txt lines carry the current values', () => {
  const v = V.effectiveVolume({ volume: { keepMonths: 6 } }, {});
  assert.match(V.yamlBlock(v), /^defaults:\n {2}volume:\n {4}indexFormat: logstash-\*-YYYY\.MM\.DD/);
  assert.match(V.yamlBlock(v), /tag: {9}\[ tag1, labels\.tag1, tags \]/);
  assert.match(V.yamlBlock(v), /keepMonths: {2}6/);
  assert.match(V.yamlBlock(v), /collectAt: {3}"06:00"/);
  const t = V.configTxtLines(v).split('\n');
  assert.equal(t.length, 13);
  assert.ok(t.includes('UI_VOLUME_TAG_FIELDS=tag1,labels.tag1,tags'));
  assert.ok(t.includes('UI_VOLUME_KEEP_MONTHS=6'));
  assert.ok(t.includes('UI_VOLUME_EXTRA_NAME=Dataset'));
});

test('a nested default prints as text, never [object Object]', () => {
  assert.equal(V.displayValue(V.VOLUME_DEFAULTS.extra), 'name: Dataset · fields: event.dataset, log_type');
  assert.equal(V.displayValue(['a', 'b']), 'a, b');
  assert.equal(V.displayValue(25), '25');
  assert.ok(!V.displayValue(V.VOLUME_DEFAULTS).includes('[object'));
});

test('the check column says what is missing and what it costs', () => {
  assert.deepEqual(V.checkCell('tag', { key: 'tag', resolved: 'tag1', type: 'keyword' }), { ok: true, text: 'tag1 (keyword)' });
  assert.deepEqual(V.checkCell('eventSize', { key: 'eventSize', resolved: null }), { ok: false, text: 'not in mapping: Event bytes will read "not measured"' });
  assert.equal(V.checkCell('subSize', { key: 'subSize', resolved: null }).ok, false);
  assert.equal(V.checkCell('tag', undefined).ok, null);
  assert.deepEqual(V.indicesCell({ match: 150, skipped: ['metrics-2026.09', '.kibana_1'] }), { ok: true, text: '150 match · 2 skipped (metrics-2026.09, .kibana_1)' });
  assert.match(V.indicesCell({ match: 1, skipped: ['a', 'b', 'c', 'd'] }).text, /\+2 more/);
  assert.equal(V.indicesCell({ match: 0, skipped: [] }).ok, false);
});

test('an older core is recognised by its unknown-message answer', () => {
  assert.ok(V.isUnknownType({ ok: false, kind: 'bad_message', message: 'Unknown message type "VOLUME_SETTINGS"' }));
  assert.ok(V.isUnknownType({ ok: false, message: 'unknown message VOLUME_FIELDS_CHECK' }));
  assert.ok(!V.isUnknownType({ ok: false, kind: 'cluster', message: 'unreachable' }));
  assert.ok(!V.isUnknownType({ ok: true }));
});
