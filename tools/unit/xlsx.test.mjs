/**
 * The spreadsheet writer.
 *
 * A malformed .xlsx is worse than no export: it downloads, it looks like a file, and it
 * fails in Excel on somebody else's machine hours later. So the pure pieces are checked
 * here against published values, and the container is also checked from the outside — by
 * a different implementation entirely — in tools/verify-xlsx.py.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const { crc32, zip, workbook, xmlText, cellRef, safeSheetName, XLSX_MIME } =
  await import(pathToFileURL(path.join(ROOT, 'ui/js/lib/xlsx.js')).href);

const bytes = (s) => new TextEncoder().encode(s);
const view = (b) => new DataView(b.buffer, b.byteOffset, b.byteLength);
const u32 = (b, at) => view(b).getUint32(at, true);
const u16 = (b, at) => view(b).getUint16(at, true);

test('crc32 matches the published check values', () => {
  // The standard vectors. Getting this wrong produces an archive every unzipper rejects.
  assert.equal(crc32(bytes('')), 0x00000000);
  assert.equal(crc32(bytes('a')), 0xe8b7be43);
  assert.equal(crc32(bytes('123456789')), 0xcbf43926);
  assert.equal(crc32(bytes('The quick brown fox jumps over the lazy dog')), 0x414fa339);
});

test('the archive carries the signatures an unzipper looks for', () => {
  const z = zip([{ name: 'a.txt', data: bytes('hello') }, { name: 'b/c.txt', data: bytes('world') }]);
  assert.equal(u32(z, 0), 0x04034b50, 'no local file header at the start');
  // End-of-central-directory is the last 22 bytes when there is no archive comment.
  assert.equal(u32(z, z.length - 22), 0x06054b50, 'no end-of-central-directory record');
  assert.equal(u16(z, z.length - 22 + 10), 2, 'the directory does not list both entries');
});

test('the central directory points at where each entry really is', () => {
  // A wrong offset is the classic way a hand-written zip opens in one tool and not
  // another: the reader that trusts the directory lands in the middle of a file.
  const z = zip([{ name: 'first', data: bytes('AAAA') }, { name: 'second', data: bytes('BBBBBB') }]);
  const dirAt = u32(z, z.length - 22 + 16);
  let at = dirAt;
  for (const want of ['first', 'second']) {
    assert.equal(u32(z, at), 0x02014b50, `no central header for ${want}`);
    const nameLen = u16(z, at + 28);
    const name = new TextDecoder().decode(z.slice(at + 46, at + 46 + nameLen));
    assert.equal(name, want);
    const localAt = u32(z, at + 42);
    assert.equal(u32(z, localAt), 0x04034b50, `${want}: the directory points at something that is not a header`);
    at += 46 + nameLen;
  }
});

test('the stored sizes and checksum match the data', () => {
  const data = bytes('some content');
  const z = zip([{ name: 'f', data }]);
  assert.equal(u32(z, 14), crc32(data), 'the local header carries the wrong checksum');
  assert.equal(u32(z, 18), data.length, 'compressed size should equal the data for a stored entry');
  assert.equal(u32(z, 22), data.length, 'uncompressed size is wrong');
  assert.equal(u16(z, 8), 0, 'the entry claims a compression method it does not use');
});

test('the same data produces the same bytes', () => {
  // No timestamps in the headers, so a report generated twice is diffable and a test can
  // compare files rather than only sizes.
  const mk = () => workbook([{ name: 'S', rows: [['a', 1]] }]);
  assert.deepEqual(Array.from(mk()), Array.from(mk()));
});

test('a workbook has every part Excel requires', () => {
  const z = workbook([{ name: 'One', rows: [['x']] }, { name: 'Two', rows: [['y']] }]);
  const text = new TextDecoder().decode(z);
  for (const part of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml',
                      'xl/_rels/workbook.xml.rels', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml']) {
    assert.ok(text.includes(part), `the archive has no ${part}`);
  }
});

test('numbers stay numbers and text stays text', () => {
  const z = workbook([{ name: 'S', rows: [['device', 41.5, 'has <angles> & ampersands']] }]);
  const text = new TextDecoder().decode(z);
  assert.ok(text.includes('<v>41.5</v>'), 'a number was written as a string and cannot be summed');
  assert.ok(text.includes('t="inlineStr"'), 'text was not written as an inline string');
  assert.ok(text.includes('&lt;angles&gt; &amp; ampersands'), 'text was not escaped');
  assert.ok(!text.includes('<angles>'), 'raw markup reached the sheet');
});

test('an empty cell is empty, not a zero', () => {
  // The distinction the rest of this codebase insists on, in the one place it would
  // silently become a figure somebody totals.
  const z = workbook([{ name: 'S', rows: [[null, 0, '']] }]);
  const text = new TextDecoder().decode(z);
  const row = text.slice(text.indexOf('<row r="1">'), text.indexOf('</row>'));
  assert.ok(/<c r="A1"\/>/.test(row), `A1 should be an empty cell: ${row}`);
  assert.ok(/<c r="B1"><v>0<\/v><\/c>/.test(row), `B1 should be a real zero: ${row}`);
  assert.ok(/<c r="C1"\/>/.test(row), `C1 should be empty: ${row}`);
});

test('column letters run past Z', () => {
  assert.equal(cellRef(0, 0), 'A1');
  assert.equal(cellRef(25, 0), 'Z1');
  assert.equal(cellRef(26, 3), 'AA4');
  assert.equal(cellRef(51, 0), 'AZ1');
  assert.equal(cellRef(52, 0), 'BA1');
});

test('sheet names are made legal without becoming identical', () => {
  assert.equal(safeSheetName('Log delay'), 'Log delay');
  assert.equal(safeSheetName(''), 'Sheet1');
  assert.ok(!/[:\\/?*[\]]/.test(safeSheetName('a/b:c?d*e[f]g')), 'illegal characters survived');
  assert.ok(safeSheetName('x'.repeat(60)).length <= 31, 'a long name was not truncated');

  // Two sheets whose names only differ past character 31 must not collide.
  const z = workbook([
    { name: `${'long name '.repeat(4)}A`, rows: [['1']] },
    { name: `${'long name '.repeat(4)}B`, rows: [['2']] },
  ]);
  const names = [...new TextDecoder().decode(z).matchAll(/<sheet name="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(new Set(names).size, 2, `duplicate sheet names: ${names.join(' | ')}`);
});

test('control characters XML cannot carry are dropped, not escaped', () => {
  assert.equal(xmlText(`a${String.fromCharCode(1)}bc`), 'abc');
  assert.equal(xmlText('keep\ttabs\nand\nnewlines'), 'keep\ttabs\nand\nnewlines');
});

test('the mime type is the one Excel registers', () => {
  assert.equal(XLSX_MIME, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
});
