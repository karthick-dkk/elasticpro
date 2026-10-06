/**
 * A spreadsheet, written here rather than fetched.
 *
 * An .xlsx is a ZIP of XML parts. The app ships unbundled with no npm and no CDN, so
 * SheetJS is not on the table — and it would be 700kB to produce a file this small.
 * What is needed is a fraction of the format: a workbook, one or more sheets, inline
 * strings, and numbers that stay numbers so a column can be summed in Excel.
 *
 * Two deliberate simplifications:
 *
 *   * **Stored, not deflated.** Every entry goes in uncompressed. A ZIP writer without a
 *     compressor is a hundred lines; with one it needs DEFLATE, which is neither small
 *     nor worth writing by hand. The files are a few hundred kB and open identically.
 *   * **Inline strings, no shared table.** The shared-strings part exists to deduplicate
 *     text across a large book. Ours are reports of a few thousand rows, where the table
 *     costs more complexity than it saves bytes.
 *
 * The output opens in Excel, LibreOffice and Numbers.
 */

/* --------------------------------- ZIP plumbing --------------------------------- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const utf8 = (s) => new TextEncoder().encode(s);

/**
 * A ZIP archive with every entry stored uncompressed.
 *
 * @param files [{ name, data: Uint8Array }]
 * @returns {Uint8Array}
 */
export function zip(files) {
  const parts = [];
  const central = [];
  let offset = 0;

  for (const f of files) {
    const name = utf8(f.name);
    const data = f.data;
    const sum = crc32(data);

    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);   // local file header
    lv.setUint16(4, 20, true);           // version needed
    lv.setUint16(6, 0, true);            // flags
    lv.setUint16(8, 0, true);            // method: stored
    lv.setUint16(10, 0, true);           // time — fixed, so the same data gives the same file
    lv.setUint16(12, 0x21, true);        // date: 1980-01-01, the epoch the format starts at
    lv.setUint32(14, sum, true);
    lv.setUint32(18, data.length, true); // compressed size
    lv.setUint32(22, data.length, true); // uncompressed size
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true);           // extra length
    local.set(name, 30);

    const dir = new Uint8Array(46 + name.length);
    const dv = new DataView(dir.buffer);
    dv.setUint32(0, 0x02014b50, true);   // central directory header
    dv.setUint16(4, 20, true);           // version made by
    dv.setUint16(6, 20, true);           // version needed
    dv.setUint16(8, 0, true);
    dv.setUint16(10, 0, true);
    dv.setUint16(12, 0, true);
    dv.setUint16(14, 0x21, true);
    dv.setUint32(16, sum, true);
    dv.setUint32(20, data.length, true);
    dv.setUint32(24, data.length, true);
    dv.setUint16(28, name.length, true);
    dv.setUint16(30, 0, true);           // extra
    dv.setUint16(32, 0, true);           // comment
    dv.setUint16(34, 0, true);           // disk
    dv.setUint16(36, 0, true);           // internal attrs
    dv.setUint32(38, 0, true);           // external attrs
    dv.setUint32(42, offset, true);      // where the local header is
    dir.set(name, 46);

    parts.push(local, data);
    central.push(dir);
    offset += local.length + data.length;
  }

  const centralSize = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);     // end of central directory
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const all = [...parts, ...central, end];
  const total = all.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of all) { out.set(p, at); at += p.length; }
  return out;
}

/* ---------------------------------- the sheet ---------------------------------- */

/**
 * XML text escaping.
 *
 * Cell values are device names, index names and error strings that came from a cluster.
 * A hostname containing `&` or `<` must not be able to end the cell it is in — that is
 * a corrupt file at best, and at worst a document that says something other than what
 * the data said. Control characters that XML 1.0 forbids outright are dropped rather
 * than escaped, because there is no escape for them.
 */
export function xmlText(v) {
  return String(v === null || v === undefined ? '' : v)
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** A1, B1 … Z1, AA1. */
export function cellRef(col, row) {
  let s = '';
  let n = col;
  do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return `${s}${row + 1}`;
}

/**
 * One cell. A number stays a number so Excel can sum the column; everything else is an
 * inline string. `null` is an empty cell, which is not the same as a zero — the
 * distinction this codebase makes everywhere else, and a spreadsheet is the one place it
 * would silently become a figure somebody totals.
 */
function cellXml(value, col, row) {
  const ref = cellRef(col, row);
  if (value === null || value === undefined || value === '') return `<c r="${ref}"/>`;
  if (typeof value === 'number' && isFinite(value)) return `<c r="${ref}"><v>${value}</v></c>`;
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlText(value)}</t></is></c>`;
}

function sheetXml(rows) {
  const body = rows.map((cells, r) =>
    `<row r="${r + 1}">${cells.map((v, c) => cellXml(v, c, r)).join('')}</row>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`
    + `<sheetData>${body}</sheetData></worksheet>`;
}

/** Excel refuses a sheet name over 31 characters or containing : \ / ? * [ ] */
export function safeSheetName(name, fallback = 'Sheet1') {
  const clean = String(name || '').replace(/[:\\/?*[\]]/g, ' ').trim().slice(0, 31);
  return clean || fallback;
}

/**
 * Build a workbook.
 *
 * @param sheets [{ name, rows: Array<Array<string|number|null>> }]
 * @returns {Uint8Array} the bytes of an .xlsx
 */
export function workbook(sheets) {
  const used = new Set();
  const named = sheets.map((s, i) => {
    let n = safeSheetName(s.name, `Sheet${i + 1}`);
    // Excel will not open a book with two sheets of the same name, and truncating to 31
    // characters is a good way to produce two.
    let k = 2;
    while (used.has(n.toLowerCase())) n = `${safeSheetName(s.name, `Sheet${i + 1}`).slice(0, 28)} ${k++}`;
    used.add(n.toLowerCase());
    return { name: n, rows: s.rows || [] };
  });

  const files = [
    { name: '[Content_Types].xml', data: utf8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
      + `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
      + `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>`
      + `<Default Extension="xml" ContentType="application/xml"/>`
      + `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>`
      + named.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')
      + `</Types>`) },
    { name: '_rels/.rels', data: utf8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
      + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
      + `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>`
      + `</Relationships>`) },
    { name: 'xl/workbook.xml', data: utf8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
      + `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" `
      + `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>`
      + named.map((s, i) => `<sheet name="${xmlText(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')
      + `</sheets></workbook>`) },
    { name: 'xl/_rels/workbook.xml.rels', data: utf8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
      + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
      + named.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
      + `</Relationships>`) },
    ...named.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: utf8(sheetXml(s.rows)) })),
  ];
  return zip(files);
}

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
