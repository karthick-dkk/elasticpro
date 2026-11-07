/**
 * Planning arithmetic (docs/REPORTS.md "Planning"): tiers, single node, masters from N data
 * nodes, volume-scaled and fixed roles, follows, the backup target, [set] left out of totals.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const P = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/plan.js')).href);

const role = (name, rule, x = {}) => ({ on: true, name, rule, cpu: null, ram: null, root: null, notes: '', ...x });
const STANDARD = {
  name: 'Standard', backup: 'disk', roles: [
    role('Forwarder', 'volume', { cap: 150, cpu: 8, ram: 16 }),
    role('Parser', 'volume', { cap: 150, cpu: 8, ram: 16 }),
    role('Elasticsearch hot', 'tier', { tier: 'hot', nodeTB: 8 }),
    role('Elasticsearch warm', 'tier', { tier: 'warm', nodeTB: null }),
    role('Elasticsearch master', 'whenData', { count: 3, from: 3 }),
    role('Elasticsearch coordinating', 'whenData', { count: 2, from: null }),
    role('Engine', 'volume', { cap: null }),
    role('AI/ML', 'fixed', { count: 1 }),
    role('ULM', 'target', { target: 'ulm', cap: null }),
    role('S3 backup', 'target', { target: 's3' }),
    role('Other servers', 'fixed', { count: null }),
  ],
};
const row = (plan, name) => plan.rows.find((r) => r.role === name);

test('the board defaults: 500 GB a day, 30 hot days, disk backups', () => {
  const p = P.computePlan(STANDARD, {});
  assert.deepEqual(p.input, { perDay: 500, hotDays: 30, warmDays: 0, days: 30, bkDays: 30, buffer: 30, replicas: 0, backup: 'disk' });
  // 500 x 30 x 1.3 = 19500 GB on hot; one 8 TB node would not hold it: ceil(19.5 / 8) = 3.
  assert.equal(row(p, 'Elasticsearch hot').count, 3);
  assert.equal(p.totals.liveGB, 19500);
  // Each node needs 6.5 TB, bought as 7 TB: the tile is the rows' sum, 3 x 7 TB.
  assert.equal(row(p, 'Elasticsearch hot').liveText, '7 TB');
  assert.equal(p.totals.liveText, '21 TB');
  // Forwarder and parser: ceil(500 / 150) = 4 each.
  assert.equal(row(p, 'Forwarder').count, 4);
  assert.equal(row(p, 'Parser').cpuT, 32);
  assert.equal(row(p, 'Parser').ramT, 64);
});

test('no warm days: the warm tier has no nodes; hot days only', () => {
  const p = P.computePlan(STANDARD, {});
  const w = row(p, 'Elasticsearch warm');
  assert.equal(w.off, true);
  assert.match(w.rule, /no warm days/);
  const withWarm = P.computePlan(STANDARD, { warmDays: 60 });
  const w2 = row(withWarm, 'Elasticsearch warm');
  assert.equal(w2.count, null, 'warm node size is [set]: the count is unknown, not 0');
  assert.match(w2.rule, /60 warm days ÷ \[set\] TB per node/);
  assert.equal(withWarm.totals.liveGB, 500 * 90 * 1.3);
  assert.equal(withWarm.totals.dataNodes, 3, 'an unknown tier adds no data nodes to the count');
});

test('replicas multiply the live disk, never the backup', () => {
  const p = P.computePlan(STANDARD, { replicas: 1 });
  assert.equal(p.totals.liveGB, 500 * 30 * 1.3 * 2);
  assert.equal(p.totals.backupGB, 500 * 30 * 1.3);
  assert.equal(row(p, 'Elasticsearch hot').bkGB, 500 * 30 * 1.3);
  assert.equal(row(p, 'Elasticsearch hot').bkText, '20 TB shared');
});

test('one data node holds every role: no dedicated master, single-node note', () => {
  const p = P.computePlan(STANDARD, { perDay: 20, hotDays: 10 });
  const hot = row(p, 'Elasticsearch hot');
  assert.equal(hot.count, 1);
  assert.match(hot.rule, /single node, all roles/);
  const master = row(p, 'Elasticsearch master');
  assert.equal(master.off, true);
  assert.match(master.rule, /the data nodes keep this role \(under 3 data nodes\)/);
});

test('masters appear from N data nodes; coordinating with no N is [set]', () => {
  const p = P.computePlan(STANDARD, {});
  assert.equal(p.totals.dataNodes, 3);
  assert.equal(row(p, 'Elasticsearch master').count, 3);
  assert.equal(row(p, 'Elasticsearch master').rule, '3 dedicated, from 3 data nodes');
  const c = row(p, 'Elasticsearch coordinating');
  assert.equal(c.count, null);
  assert.equal(c.rule, '2 from [set] data nodes');
});

test('fixed roles, and [set] left out of every total with the count of what was left out', () => {
  const p = P.computePlan(STANDARD, {});
  assert.equal(row(p, 'AI/ML').count, 1);
  assert.equal(row(p, 'Other servers').countText, '[set]');
  // Counted: 4 + 4 + 3 + 3 masters + 1 AI/ML = 15. Not counted: coordinating, engine, other.
  assert.equal(p.totals.servers, 15);
  assert.equal(p.totals.unsetCount, 3);
  assert.equal(p.totals.serversText, '15 +3');
  // CPU: only forwarder + parser have one: 4x8 + 4x8.
  assert.equal(p.totals.cpu, 64);
  assert.equal(p.totals.ram, 128);
  assert.equal(p.totals.cpuNote, '+ 6 roles without a CPU spec');
  assert.equal(P.computePlan({ roles: [role('A', 'fixed', { count: 2, cpu: 4, ram: 8 })] }, {}).totals.cpuNote, 'every role counted');
  assert.equal(P.computePlan({ roles: [role('A', 'fixed', { count: 2 })] }, {}).totals.cpuNote, '+ 1 role without a CPU spec');
});

test('backup target: disk shows /backup on the hot row; S3 and ULM hide it', () => {
  const disk = P.computePlan(STANDARD, { backup: 'disk' });
  assert.equal(disk.totals.showBackupCol, true);
  assert.equal(disk.totals.backupLabel, '/backup disk');
  assert.equal(row(disk, 'S3 backup').off, true);
  assert.match(row(disk, 'S3 backup').rule, /backups go to \/backup disk/);
  assert.equal(row(disk, 'ULM').off, true);
  assert.equal(row(disk, 'Elasticsearch warm').bkText, '—');

  const s3 = P.computePlan(STANDARD, { backup: 's3' });
  assert.equal(s3.totals.showBackupCol, false);
  assert.equal(row(s3, 'Elasticsearch hot').bkText, '—');
  const bucket = row(s3, 'S3 backup');
  assert.equal(bucket.countText, 'bucket');
  assert.equal(bucket.rule, 'S3 bucket: 15 TB (volume × backup days)');
  assert.equal(s3.totals.backupGB, 500 * 30, 'S3 holds volume x days, no buffer');
  assert.equal(s3.totals.backupLabel, 'S3 backup');
  assert.equal(s3.totals.servers, 15, 'a bucket is not a server');

  const ulm = P.computePlan(STANDARD, { backup: 'ulm' });
  assert.equal(ulm.totals.backupLabel, 'ULM archive in S3');
  const u = row(ulm, 'ULM');
  assert.equal(u.off, false);
  assert.equal(u.count, null, 'ULM GB per day per server is [set]');
  assert.match(u.rule, /archives 15 TB to S3/);
  assert.equal(row(ulm, 'S3 backup').off, true);
  const ulmSet = P.computePlan({ roles: [role('ULM', 'target', { target: 'ulm', cap: 400 })] }, { backup: 'ulm' });
  assert.equal(ulmSet.rows[0].count, 2);
});

test('follows: one per N of another role; off when the followed role has none', () => {
  const t = { roles: [role('Parser', 'volume', { cap: 100 }), role('Queue', 'follows', { of: 'parser', per: 3, cpu: 2 })] };
  const p = P.computePlan(t, { perDay: 700 });
  assert.equal(row(p, 'Parser').count, 7);
  assert.equal(row(p, 'Queue').count, 3);
  assert.equal(row(p, 'Queue').rule, 'one per 3 parser');
  assert.equal(row(p, 'Queue').cpuT, 6);
  const unknown = P.computePlan({ roles: [role('P', 'volume', { cap: null }), role('Q', 'follows', { of: 'P', per: 3 })] }, {});
  assert.equal(row(unknown, 'Q').count, null);
  const loop = P.computePlan({ roles: [role('A', 'follows', { of: 'B', per: 1 }), role('B', 'follows', { of: 'A', per: 1 })] }, {});
  assert.equal(loop.rows[0].count, null, 'a loop is unknown, never an infinite recursion');
});

test('a role switched off is not in the plan', () => {
  const t = { roles: [role('A', 'fixed', { count: 2 }), { ...role('B', 'fixed', { count: 5 }), on: false }] };
  const p = P.computePlan(t, {});
  assert.deepEqual(p.rows.map((r) => r.role), ['A']);
  assert.equal(p.totals.servers, 2);
});

test('inputs are bounded like the board: volume and hot days at least 1, replicas whole', () => {
  const i = P.normaliseInput({ perDay: '0', hotDays: 'x', warmDays: -3, replicas: 1.9, bkDays: '', backup: 'tape' });
  assert.equal(i.perDay, 1);
  assert.equal(i.hotDays, 1);
  assert.equal(i.warmDays, 0);
  assert.equal(i.replicas, 1);
  assert.equal(i.bkDays, 0, 'a blank field is the minimum, as on the board');
  assert.equal(P.normaliseInput({}).bkDays, 30, 'a missing one is the default');
  assert.equal(i.backup, 'disk');
});

test('zero or missing divisors are [set], not a division by zero', () => {
  const p = P.computePlan({ roles: [role('V', 'volume', { cap: 0 }), role('T', 'tier', { tier: 'hot', nodeTB: 0 })] }, {});
  assert.equal(p.rows[0].count, null);
  assert.equal(p.rows[1].count, null);
});

test('CSV: [set] stays [set]; the /backup column follows the target', () => {
  const rows = P.planCsvRows(P.computePlan(STANDARD, {}));
  assert.equal(rows[0].join(','), P.PLAN_CSV.join(','));
  const other = rows.find((r) => r[0] === 'Other servers');
  assert.equal(other[2], '[set]');
  assert.equal(other[3], '[set]');
  assert.equal(rows[rows.length - 1][0], 'Total');
  assert.equal(rows[rows.length - 1][2], '15 +3');
  const hot = rows.find((r) => r[0] === 'Elasticsearch hot');
  assert.equal(hot[6], '7 TB');
  assert.equal(hot[7], '20 TB shared');
  assert.equal(rows[rows.length - 1][6], '21 TB');
  const s3 = P.planCsvRows(P.computePlan(STANDARD, { backup: 's3' }));
  assert.ok(!s3[0].includes('backup_disk'));
  assert.ok(s3.every((r) => r.length === s3[0].length));
});

test('based on a cluster: the live retention policy as hot days, and the volume as GB', () => {
  assert.deepEqual(P.inputsFromCluster({ perDayBytes: 412.34e9, liveRetention: '45d' }), { perDay: 412.3, hotDays: 45 });
  assert.deepEqual(P.inputsFromCluster({ perDayBytes: null, liveRetention: '' }), {});
  assert.equal(P.retentionDays('4w'), 28);
  assert.equal(P.retentionDays('3 months'), 90);
  assert.equal(P.retentionDays('1y'), 365);
  assert.equal(P.retentionDays('soon'), null);
  assert.equal(P.retentionDays(60), 60);
});

test('the per-day rate is the shared definition: the mean of the last 7 finished days', async () => {
  const D = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/volume-daily.js')).href);
  const day = (n, eventBytes) => ({ day: `2026-10-${String(n).padStart(2, '0')}`, eventBytes });
  const rec = { days: [day(1, 1e12), day(20, 100e9), day(21, 200e9), day(22, 300e9), day(23, 400e9), day(24, 500e9), day(25, 600e9), day(26, 700e9), day(27, null)] };
  assert.equal(D.perDayEventBytes(rec, 7, { today: '2026-10-28' }), 450e9, '21 to 27 asked, 21 to 26 measured');
});

test('disk sizes are shown rounded up: never less than the arithmetic needs', () => {
  assert.equal(P.diskGB(2785.7), 3000);
  assert.equal(P.diskGB(19500), 20000);
  assert.equal(P.diskGB(500 * 30 * 1.3), 20000, 'float noise does not buy an extra TB');
  assert.equal(P.diskGB(3000.0000000001), 3000);
  assert.equal(P.diskGB(999.5), 1000);
  assert.equal(P.diskGB(479.2), 480);
  assert.equal(P.fmtGB(2785.7), '3 TB');
  assert.equal(P.fmtGB(999.5), '1 TB');
  assert.equal(P.fmtGB(479.2), '480 GB');
  // The reported page: 3 TB hot nodes, 500 GB a day, 30 days, 30 % buffer -> 19.5 TB over 7 nodes.
  const p = P.computePlan({ backup: 'disk', roles: [role('Elasticsearch hot', 'tier', { tier: 'hot', nodeTB: 3 })] }, {});
  const hot = row(p, 'Elasticsearch hot');
  assert.equal(hot.count, 7);
  assert.equal(hot.liveText, '3 TB', 'was 2.79 TB');
  assert.equal(hot.bkText, '20 TB shared', 'was 19.5 TB shared');
  assert.equal(p.totals.liveText, '21 TB');
  assert.equal(p.totals.liveBuyGB, 21000);
  assert.equal(p.totals.liveGB, 19500, 'the requirement itself is unchanged');
  assert.equal(p.totals.backupText, '20 TB');
});
