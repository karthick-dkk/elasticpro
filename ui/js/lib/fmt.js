/** Formatting helpers. */

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB'];

/** Unknown is not zero: Number(null) is 0, so null is caught before it. */
const toNum = (n) => (n === null || n === '' ? NaN : Number(n));

export function bytes(n, digits) {
  n = toNum(n);
  if (!isFinite(n) || n < 0) return '–';
  if (n === 0) return '0 B';
  const i = Math.min(UNITS.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / Math.pow(1024, i);
  const d = digits !== undefined ? digits : v >= 100 ? 0 : v >= 10 ? 1 : 2;
  return `${v.toFixed(i === 0 ? 0 : d)} ${UNITS[i]}`;
}

/**
 * A number of GB (1024³ bytes) as a figure, the one definition of its digits: one decimal from
 * 100 GB, two from 1 GB, three significant digits below it, so a size that is there is never
 * written as 0. Unknown stays null.
 */
export function gbDigits(g) {
  g = toNum(g);
  if (!isFinite(g)) return null;
  const a = Math.abs(g);
  return a >= 100 ? Math.round(g * 10) / 10 : a >= 1 ? Math.round(g * 100) / 100 : Number(g.toPrecision(3));
}
/** Bytes as that figure, for a file's GB column (null: an empty cell). */
export const gbFigure = (n) => gbDigits(toNum(n) / 1024 ** 3);

export function num(n) {
  n = toNum(n);
  if (!isFinite(n)) return '–';
  return n.toLocaleString();
}

export function compact(n) {
  n = toNum(n);
  if (!isFinite(n)) return '–';
  return Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(n);
}

/**
 * A percentage in words, the one definition. All and none are said only when they are exactly so:
 * 99.7 at no digits is "99.7%", 99.99 is ">99.9%", 0.01 is "<0.1%" — never 100 % with one missing,
 * never 0 % with one present. `gap` goes before the sign ("12 %").
 */
export function pct(n, digits = 1, gap = '') {
  n = toNum(n);
  if (!isFinite(n)) return '–';
  const all = (d) => n < 100 && Number(n.toFixed(d)) >= 100;
  const none = (d) => n > 0 && Number(n.toFixed(d)) === 0;
  const d = all(digits) || none(digits) ? Math.max(1, digits) : digits;
  const text = all(d) ? `>${(100 - 10 ** -d).toFixed(d)}` : none(d) ? `<${(10 ** -d).toFixed(d)}` : n.toFixed(d);
  return `${text}${gap}%`;
}

/** `part` of `total` as a percentage (pct); '–' when either is unknown or there is no total. */
export function sharePct(part, total, digits = 0, gap = '') {
  const a = toNum(part), b = toNum(total);
  return isFinite(a) && b > 0 ? pct((a / b) * 100, digits, gap) : '–';
}

/**
 * Disk use written once: "56 % · 156 of 279 GB". The unit is said once when both sizes share
 * it. Empty when the percentage is not known — the caller says why, this does not guess.
 */
export function diskUseText(disk) {
  if (!disk || disk.percent === null || disk.percent === undefined || !isFinite(disk.percent)) return '';
  const used = bytes(disk.used), total = bytes(disk.total);
  const share = pct(disk.percent, 0, ' ');
  if (total === '–') return share;
  const u = used.split(' ')[1], t = total.split(' ')[1];
  return `${share} \u00b7 ${used === '–' ? '–' : u === t ? used.split(' ')[0] : used} of ${total}`;
}

export function dur(ms) {
  ms = toNum(ms);
  if (!isFinite(ms) || ms < 0) return '–';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 90) return `${s.toFixed(s < 10 ? 1 : 0)} s`;
  const m = s / 60;
  if (m < 90) return `${m.toFixed(0)} m`;
  const hr = m / 60;
  if (hr < 48) return `${hr.toFixed(1)} h`;
  return `${(hr / 24).toFixed(1)} d`;
}

export function ago(ts) {
  if (!ts) return 'never';
  const d = Date.now() - Number(ts);
  if (d < 0) return 'in ' + dur(-d);
  if (d < 45000) return 'just now';
  return dur(d) + ' ago';
}

const DT = new Intl.DateTimeFormat(undefined, {
  year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
});
export function dt(ts) { return ts ? DT.format(new Date(Number(ts))) : '–'; }
/** This browser's zone at a time, as dtz says it ("GMT+5:30"); '' when it has no name. */
const zoneName = (ts) => { const z = ZONE.formatToParts(new Date(Number(ts))).find((p) => p.type === 'timeZoneName'); return z ? ` ${z.value}` : ''; };
const HM = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
/** The time alone with its zone ("14:02 GMT+5:30"); with its date (dtz) when that is not today. */
export function hmz(ts, now = Date.now()) {
  if (!ts) return '–';
  return new Date(Number(ts)).toDateString() === new Date(now).toDateString() ? `${HM.format(new Date(Number(ts)))}${zoneName(ts)}` : dtz(ts);
}
const ZONE = new Intl.DateTimeFormat('en', { timeZoneName: 'short' });
/** dt with its zone said ("… GMT+5:30"): for a time inside a sentence, where no column names the zone. */
export function dtz(ts) {
  if (!ts) return '–';
  return `${dt(ts)}${zoneName(ts)}`;
}
export function dateOnly(ts) { return ts ? new Date(Number(ts)).toISOString().slice(0, 10) : '–'; }

/** yyyy.MM.dd used by logstash daily indices. */
export function ymdDots(d, sep = '.') {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${sep}${p(d.getMonth() + 1)}${sep}${p(d.getDate())}`;
}

export function eachDay(fromISO, toISO) {
  const out = [];
  const a = new Date(fromISO + 'T00:00:00');
  const b = new Date(toISO + 'T00:00:00');
  for (let d = new Date(a); d <= b; d.setDate(d.getDate() + 1)) out.push(new Date(d));
  return out;
}

export function healthClass(h) {
  const s = String(h || '').toLowerCase();
  if (s === 'green' || s === 'success' || s === 'ok' || s === 'running' || s === 'online') return 'green';
  if (s === 'yellow' || s === 'partial' || s === 'in_progress' || s === 'stopping') return 'yellow';
  if (s === 'red' || s === 'failed' || s === 'error' || s === 'stopped' || s === 'offline') return 'red';
  return 'grey';
}

export function diskClass(p, warn = 80, crit = 90) {
  if (!isFinite(p)) return 'grey';
  if (p >= crit) return 'red';
  if (p >= warn) return 'yellow';
  return 'green';
}

/** `1 day`, `2 days` — a count with a noun that agrees with it. */
export function plural(n, noun, plur) {
  return `${n} ${n === 1 ? noun : plur || `${noun}s`}`;
}

export function csvEscape(v) {
  let s = v === null || v === undefined ? '' : String(v);
  // A cell starting with = + - @ (or a tab / return) is a formula to a spreadsheet, and an
  // index name or a request path is data somebody else chose. Numbers keep their sign.
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows, headers) {
  const cols = headers || Object.keys(rows[0] || {});
  // The header row needs escaping exactly as much as the data does: a column name with a
  // comma in it silently adds a column to the first line and misaligns the whole file.
  return [cols.map(csvEscape).join(','), ...rows.map((r) => cols.map((c) => csvEscape(r[c])).join(','))].join('\n');
}

/**
 * Save bytes rather than text.
 *
 * download() takes a string and hands it to FILE_WRITE on the desktop, which is a text
 * channel — a spreadsheet through it would arrive corrupt. Binary goes through the blob
 * path, which is what the hosted deployment uses for everything anyway.
 */
export function downloadBytes(name, bytes, mime = 'application/octet-stream') {
  const blob = new Blob([bytes], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function download(name, text, mime = 'text/plain') {
  const T = globalThis.__TAURI__;
  if (T && T.dialog && T.core) {
    // inside the desktop app a blob download goes nowhere; use the native save dialog
    T.dialog.save({ defaultPath: name, title: `Save ${name}` }).then((p) => {
      if (p) return T.core.invoke('bridge', { msg: { type: 'FILE_WRITE', path: p, text } });
    }).catch(() => {});
    return;
  }
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
