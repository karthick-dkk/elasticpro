/**
 * Jobs › Requests › Cost (docs/JOBS.md "Query cost"): what ElasticPro's requests cost each
 * cluster, per kind of work (a poller dataset, a job, a page), over the last day — requests per
 * hour, average and p95 time, bytes, timeouts and deferrals — and the 10 most expensive recent
 * requests. Drawn from one REQUEST_COST answer; it reads nothing else and sends no cluster
 * anything. The page (requests.js) owns the 30-s read and the tab bar. An administrator's.
 */

import { h } from '../lib/dom.js';
import { card, table, keptCard, keptTable } from './common.js';
import { tableSort } from '../lib/table-sort.js';
import { costRows, costTotals, topRows, msText, bytesText, perHourText, windowText } from '../core/request-cost.js';
import { exactTime } from '../core/job-detail.js';

let C = null;
let R = () => {};
const K = (key, title, sub, body, actions) => (C ? keptCard(C, `rc:${key}`, title, sub, body, actions) : card(title, sub, body, actions));
const T = (key, headers, rows, opts) => (C ? keptTable(C, `rc:${key}`, headers, C.sameAll(`rc:${key}:row`, rows), opts) : table(headers, rows, opts));
/** A table whose heads sort like every Jobs table (lib/table-sort.js): `cols` is `[label, key | null, {type, value} | null, num]`. */
const ST = (key, cols, items, row, opts = {}) => {
  const sort = tableSort(`requests.cost.${key}`, { onChange: () => R() });
  const spec = Object.fromEntries(cols.filter((c) => c[1]).map((c) => [c[1], c[2]]));
  const shown = sort.apply(items || [], spec);
  const headers = cols.map(([label, k, , n, title]) => ({ label, sort: k, num: !!n, title: title || null }));
  return T(key, headers, shown.map(row), { ...opts, sort });
};
const dash = () => h('span.muted', '—');
const n = (v) => (v ? Number(v).toLocaleString('en') : h('span.muted', '0'));

/**
 * The Cost tab: `answer` the last REQUEST_COST answer (null until read), `error` why the last
 * read failed, `cache` the page's nodeCache, `redraw` the page's redraw, `nameOf` a cluster's
 * name, `tz` the server's zone for the times.
 */
export function costView(answer, { error = null, cache = null, redraw = () => {}, nameOf = (id) => id, tz = null } = {}) {
  C = cache; R = redraw;
  if (!answer) {
    return [h(`div.${error ? 'banner.err' : 'muted.rc-wait'}#rc-state`, error
      ? (/unknown|bad_message/i.test(error) ? 'This server does not keep request costs yet: REQUEST_COST needs ElasticPro 0.3.82.' : `The request costs could not be read: ${error}`)
      : 'Reading the request costs…')];
  }
  const rows = costRows(answer, nameOf);
  const t = costTotals(rows);
  const head = h('div.rc-line#rc-line', { title: 'Counted in memory from every request ElasticPro sent (the report worker’s too); a request answered from the read cache or by another’s request cost the cluster nothing and is not counted. Kept for a day; a restart starts again.' },
    h('b', Number(t.requests).toLocaleString('en')), ` requests to ${t.clusters} cluster${t.clusters === 1 ? '' : 's'} ${windowText(answer, (ms) => exactTime(ms, { tz, seconds: false }).split(' ').pop())}`,
    ' · ', h('b', String(t.timeouts)), ` timeout${t.timeouts === 1 ? '' : 's'} · `, h('b', String(t.deferrals)), ` deferral${t.deferrals === 1 ? '' : 's'}`,
    error ? h('span.jb-err', ` · the last read failed: ${error}`) : null);
  const table1 = ST('kinds', [
    ['Cluster', 'name', { type: 'text', value: (r) => r.name }],
    ['Kind', 'label', { type: 'text', value: (r) => r.label }],
    ['Requests / h', 'perHour', { type: 'number', value: (r) => r.perHour, start: -1 }, true, 'requests sent per hour over the window'],
    ['Average', 'avg', { type: 'duration', value: (r) => r.avgMs, start: -1 }, true],
    ['p95', 'p95', { type: 'duration', value: (r) => r.p95Ms, start: -1 }, true, '95 % of the requests took this long or less (to the nearest step: 100 ms, 200 ms, 500 ms, 1 s, 2 s, 5 s …)'],
    ['Bytes', 'bytes', { type: 'number', value: (r) => r.bytes, start: -1 }, true, 'answer bytes read, over the requests whose size was reported'],
    ['Timeouts', 'timeouts', { type: 'number', value: (r) => r.timeouts, start: -1 }, true, 'ElasticPro gave up waiting, or closed the request past its deadline'],
    ['Deferrals', 'deferrals', { type: 'number', value: (r) => r.deferrals, start: -1 }, true, 'held back before it was sent: the request gate was full, or the job waited because the cluster was busy'],
  ], rows, (r) => h('tr', { dataset: { cluster: r.cluster, kind: r.kind } },
    h('td', r.name), h('td', { title: r.kind }, r.label),
    h('td.num', perHourText(r.perHour)),
    h('td.num', r.avgMs === null ? dash() : msText(r.avgMs)),
    h('td.num', r.p95Ms === null ? dash() : msText(r.p95Ms)),
    h('td.num', r.bytes === null ? (r.requests ? h('span.muted', 'not reported') : dash()) : bytesText(r.bytes)),
    h(`td.num${r.timeouts ? '.jb-err' : ''}`, n(r.timeouts)),
    h(`td.num${r.deferrals ? '.rc-warn' : ''}`, n(r.deferrals))), { emptyText: 'No request in the window on the clusters you can see.' });
  const tops = topRows(answer, nameOf);
  const table2 = ST('top', [
    ['Time', 'at', { type: 'date', value: (r) => r.at }],
    ['Kind', 'label', { type: 'text', value: (r) => r.label }],
    ['Cluster', 'name', { type: 'text', value: (r) => r.name }],
    ['Path', null, null, false, 'the query string’s names only: its values are not kept'],
    ['Took', 'ms', { type: 'duration', value: (r) => r.ms, start: -1 }, true],
    ['Bytes', 'bytes', { type: 'number', value: (r) => r.bytes, start: -1 }, true],
  ], tops, (r) => h('tr', { dataset: { cluster: r.cluster } },
    h('td.mono', exactTime(r.at, { tz })), h('td', { title: r.kind }, r.label), h('td', r.name),
    h('td.mono.rc-path', { title: `${r.method || 'GET'} ${r.path}${r.status ? ` · ${r.status}` : ''}` }, `${r.method || 'GET'} ${r.path}`),
    h(`td.num${r.status === 'timeout' || r.status === 'reaped' ? '.jb-err' : ''}`, msText(r.ms)),
    h('td.num', r.bytes === null || r.bytes === undefined ? h('span.muted', 'not reported') : bytesText(r.bytes))), { emptyText: 'No request in the window on the clusters you can see.' });
  // Kept tables are passed as they are (never wrapped in a fresh element); the id marks them.
  table1.id = 'rc-kinds';
  table2.id = 'rc-top';
  return [
    head,
    K('kinds', 'By cluster and kind', `${rows.length} row${rows.length === 1 ? '' : 's'} · a kind is a poller dataset, a job or a page`, table1),
    K('top', 'Most expensive recent requests', `the ${tops.length || 10} slowest ${windowText(answer)}`, table2),
  ];
}
