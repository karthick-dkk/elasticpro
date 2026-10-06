#!/usr/bin/env node
/**
 * Prove the spreadsheet writer produces a file something else can open.
 *
 *   node tools/verify-xlsx.mjs
 *
 * The unit tests check the writer against its own understanding of the format, which is
 * the one thing a writer's tests cannot do honestly: if my idea of a ZIP is wrong, so is
 * my idea of how to read one. This writes a real workbook and hands it to two
 * implementations that have never seen this code — python's zipfile, which recomputes
 * every CRC, and the system unzip — so "it opens" is a fact rather than a belief.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { workbook } from '../ui/js/lib/xlsx.js';

const out = path.join(os.tmpdir(), 'elasticpro-xlsx-verify.xlsx');
const rows = [
  ['Cluster', 'Device', 'Status', 'Delay (min)', 'Docs', 'Detail'],
  ['vm-1', 'fw-core-02', 'delayed', 41, 120, 'queue backing up'],
  ['vm-1', 'vpn-04', 'clock ahead', -37, 4, 'device clock is ahead'],
  ['vm-1', 'proxy-03', 'critical', 95, 300, 'a <parser> failed & dropped'],
  ['vm-1', 'ghost-07', 'unknown', null, 0, 'could not be measured'],
];
fs.writeFileSync(out, Buffer.from(workbook([
  { name: 'Log delay', rows },
  { name: 'Not measured', rows: [['Cluster', 'Why'], ['mock-lab', 'never asked (stopped)']] },
])));

const py = `
import sys, zipfile, xml.etree.ElementTree as ET
z = zipfile.ZipFile(${JSON.stringify(out)})
assert z.testzip() is None, "a stored CRC does not match its data"
for n in z.namelist():
    ET.fromstring(z.read(n))
ns = {'m': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
sh = ET.fromstring(z.read('xl/worksheets/sheet1.xml'))
rows = sh.findall('.//m:row', ns)
assert len(rows) == 5, f"expected 5 rows, got {len(rows)}"
def cell(c):
    v = c.find('m:v', ns)
    if v is not None: return float(v.text)
    t = c.find('m:is/m:t', ns)
    return t.text if t is not None else None
assert cell(rows[1][3]) == 41.0, "a number did not survive as a number"
assert cell(rows[4][3]) is None, "an unmeasurable delay became a value"
assert cell(rows[3][5]) == 'a <parser> failed & dropped', "escaping did not round-trip"
names = [s.get('name') for s in ET.fromstring(z.read('xl/workbook.xml')).findall('.//m:sheet', ns)]
assert names == ['Log delay', 'Not measured'], names
print("  python zipfile: every CRC matches, every part parses, values survive")
`;
try {
  process.stdout.write(execFileSync('python3', ['-c', py], { encoding: 'utf8' }));
} catch (e) {
  console.error('  python zipfile REJECTED the file:\n', (e.stderr || e.message).toString().trim());
  process.exit(1);
}
try {
  execFileSync('unzip', ['-t', out], { encoding: 'utf8' });
  console.log('  system unzip: archive is intact');
} catch (e) {
  console.error('  system unzip REJECTED the file:\n', (e.stdout || e.message).toString().trim());
  process.exit(1);
}
console.log(`ok: ${fs.statSync(out).size} byte workbook, opened by two other implementations`);
