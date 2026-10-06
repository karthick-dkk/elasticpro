/** Formatting helpers. */

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB'];

export function bytes(n, digits) {
  n = Number(n);
  if (!isFinite(n) || n < 0) return '–';
  if (n === 0) return '0 B';
  const i = Math.min(UNITS.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / Math.pow(1024, i);
  const d = digits !== undefined ? digits : v >= 100 ? 0 : v >= 10 ? 1 : 2;
  return `${v.toFixed(i === 0 ? 0 : d)} ${UNITS[i]}`;
}

export function num(n) {
  n = Number(n);
  if (!isFinite(n)) return '–';
  return n.toLocaleString();
}

export function compact(n) {
  n = Number(n);
  if (!isFinite(n)) return '–';
  return Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(n);
}

export function pct(n, digits = 1) {
  n = Number(n);
  return isFinite(n) ? `${n.toFixed(digits)}%` : '–';
}

export function dur(ms) {
  ms = Number(ms);
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
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
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
