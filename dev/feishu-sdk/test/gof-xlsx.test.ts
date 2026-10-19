import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { CellRange, columnIndex, columnLetter, translateFormula } from '../src/gof/a1.ts';
import { Snapshot, validationProjection } from '../src/gof/snapshot.ts';
import { readWorkbook } from '../src/gof/xlsx.ts';
import { parseXml } from '../src/gof/xml.ts';
import { ZipReader } from '../src/gof/zip.ts';
import { Blocked } from '../src/gof/util.ts';

function crc32(data: Buffer): number {
  let crc = ~0;
  for (const byte of data) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

/** A minimal zip writer for building workbook files by hand: the part names and XML are exactly what the test wants to feed in. */
function zip(files: Record<string, string>, deflate = true): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text, 'utf8');
    const body = deflate ? zlib.deflateRawSync(raw) : raw;
    const nameBytes = Buffer.from(name);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(deflate ? 8 : 0, 8);
    header.writeUInt32LE(crc32(raw), 14); header.writeUInt32LE(body.length, 18); header.writeUInt32LE(raw.length, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(deflate ? 8 : 0, 10);
    entry.writeUInt32LE(crc32(raw), 16); entry.writeUInt32LE(body.length, 20); entry.writeUInt32LE(raw.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28); entry.writeUInt32LE(offset, 42);
    locals.push(header, nameBytes, body);
    central.push(entry, nameBytes);
    offset += header.length + nameBytes.length + body.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const ns = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

function workbook(sheetXml: string, extra: Record<string, string> = {}, styles = ''): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gof-xlsx-')), 'book.xlsx');
  fs.writeFileSync(file, zip({
    'xl/workbook.xml': `${head}<workbook ${ns}><sheets><sheet name="表一" sheetId="1" r:id="rId1"/><sheet name="隐藏" sheetId="2" state="hidden" r:id="rId2"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `${head}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
      + '<Relationship Id="rId1" Type="x/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="x/worksheet" Target="/xl/worksheets/sheet2.xml"/></Relationships>',
    'xl/sharedStrings.xml': `${head}<sst ${ns}><si><t>头</t></si><si><r><t>富</t></r><r><t xml:space="preserve"> 文本</t></r><rPh><t>ふ</t></rPh></si><si><t>a_x000D_b</t></si></sst>`,
    'xl/styles.xml': styles || `${head}<styleSheet ${ns}><fonts><font><sz val="11"/></font><font><b/></font></fonts><fills><fill/><fill><patternFill patternType="solid"/></fill></fills>`
      + '<borders><border/></borders><cellXfs><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0"/>'
      + '<xf numFmtId="0" fontId="0" fillId="0" borderId="0"><alignment wrapText="1"/></xf><xf numFmtId="164" fontId="0" fillId="0" borderId="0"/></cellXfs>'
      + '<numFmts count="1"><numFmt numFmtId="164" formatCode="0.0"/></numFmts></styleSheet>',
    'xl/worksheets/sheet1.xml': sheetXml,
    'xl/worksheets/sheet2.xml': `${head}<worksheet ${ns}><sheetData/></worksheet>`,
    ...extra,
  }));
  return file;
}

test('cell kinds: shared and rich strings, inline strings, numbers, booleans, errors, escaped control characters, empty cells', () => {
  const file = workbook(`${head}<worksheet ${ns}><sheetData><row r="1">`
    + '<c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="inlineStr"><is><t>行内</t></is></c>'
    + '<c r="E1"><v>12.50</v></c><c r="F1" t="b"><v>1</v></c><c r="G1" t="e"><v>#N/A</v></c><c r="H1" t="str"><v>结果</v></c><c r="I1"/><c r="J1" s="1"/>'
    + '</row></sheetData></worksheet>');
  const sheet = readWorkbook(file).sheets[0]!;
  const at = (c: string) => sheet.cells.get(c)!;
  assert.deepEqual([at('A1').value, at('B1').value, at('C1').value, at('D1').value], ['头', '富 文本', 'a\rb', '行内']);
  assert.deepEqual([at('E1').kind, at('E1').value, at('F1').kind, at('G1').kind, at('H1').kind], ['n', '12.50', 'b', 'e', 's']);
  assert.equal(at('I1').value, null);
  assert.notEqual(at('J1').style, null, 'a bold empty cell still has a style of its own');
  assert.equal(readWorkbook(file).sheets[1]!.state, 'hidden');
});

test('formulas: plain, shared (filled down with moved references) and array', () => {
  const file = workbook(`${head}<worksheet ${ns}><sheetData>`
    + '<row r="1"><c r="A1"><v>1</v></c><c r="B1"><f>A1*2</f><v>2</v></c></row>'
    + '<row r="2"><c r="A2"><v>2</v></c><c r="B2"><f t="shared" ref="B2:B4" si="0">$A2+A2</f><v>4</v></c></row>'
    + '<row r="3"><c r="A3"><v>3</v></c><c r="B3"><f t="shared" si="0"/><v>6</v></c></row>'
    + '<row r="4"><c r="B4"><f t="array" ref="B4">SUM(A1:A3)</f></c></row></sheetData></worksheet>');
  const sheet = readWorkbook(file).sheets[0]!;
  assert.deepEqual(['B1', 'B2', 'B3', 'B4'].map(c => sheet.cells.get(c)!.value), ['=A1*2', '=$A2+A2', '=$A3+A3', '=SUM(A1:A3)']);
  assert.ok(['B1', 'B2', 'B3', 'B4'].every(c => sheet.cells.get(c)!.kind === 'f'));
});

test('styles are compared by content, so renumbering the style table does not look like a change', () => {
  const a = workbook(`${head}<worksheet ${ns}><sheetData><row r="1"><c r="A1" s="1"><v>1</v></c></row></sheetData></worksheet>`);
  const reordered = `${head}<styleSheet ${ns}><fonts><font><sz val="11"/></font><font><b/></font></fonts><fills><fill/><fill><patternFill patternType="solid"/></fill></fills>`
    + '<borders><border/></borders><cellXfs><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0"><alignment wrapText="1"/></xf>'
    + '<xf numFmtId="0" fontId="1" fillId="0" borderId="0"/></cellXfs></styleSheet>';
  const b = workbook(`${head}<worksheet ${ns}><sheetData><row r="1"><c r="A1" s="2"><v>1</v></c></row></sheetData></worksheet>`, {}, reordered);
  assert.equal(readWorkbook(a).sheets[0]!.cells.get('A1')!.style, readWorkbook(b).sheets[0]!.cells.get('A1')!.style);
  const other = workbook(`${head}<worksheet ${ns}><sheetData><row r="1"><c r="A1" s="3"><v>1</v></c></row></sheetData></worksheet>`);
  assert.notEqual(readWorkbook(a).sheets[0]!.cells.get('A1')!.style, readWorkbook(other).sheets[0]!.cells.get('A1')!.style);
});

test('layout parts: merges, rows, columns, filter, protection, comments, hyperlinks', () => {
  const file = workbook(`${head}<worksheet ${ns}><cols><col min="2" max="3" width="9" hidden="1"/></cols><sheetData>`
    + '<row r="1" ht="30" customHeight="1" hidden="1"><c r="A1"><v>x</v></c></row><row r="2" spans="1:2"><c r="A2"><v>y</v></c></row></sheetData>'
    + '<sheetProtection sheet="1" objects="1"/><autoFilter ref="A1:C9"><filterColumn colId="0"/></autoFilter><mergeCells count="1"><mergeCell ref="B3:A2"/></mergeCells>'
    + '<hyperlinks><hyperlink ref="A2" r:id="rId1"/><hyperlink ref="B2:B3" location="Sheet2!A1"/></hyperlinks></worksheet>',
  {
    'xl/worksheets/_rels/sheet1.xml.rels': `${head}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
      + '<Relationship Id="rId1" Type="x/hyperlink" Target="https://example.com/a" TargetMode="External"/><Relationship Id="rId2" Type="http://x/comments" Target="../comments1.xml"/></Relationships>',
    'xl/comments1.xml': `${head}<comments ${ns}><authors><author>某人</author></authors><commentList><comment ref="C5" authorId="0"><text><r><t>备</t></r><r><t>注</t></r></text></comment></commentList></comments>`,
  });
  const sheet = readWorkbook(file).sheets[0]!;
  assert.deepEqual(sheet.merges, ['A2:B3']);
  assert.deepEqual(sheet.rows, { '1': ['30', true, 0, false, null] }, 'a row with only spans has nothing to compare');
  assert.deepEqual(sheet.columns.B, [2, 3, '9', true, 0, false, null]);
  assert.equal(sheet.filter?.ref, 'A1:C9');
  assert.equal(sheet.protectedSheet, true);
  assert.deepEqual(sheet.cells.get('A2')!.link, ['https://example.com/a', null]);
  assert.deepEqual(sheet.cells.get('B3')!.link, [null, 'Sheet2!A1']);
  assert.deepEqual(sheet.cells.get('C5')!.comment, ['某人', '备注']);
  assert.equal(sheet.cells.get('C5')!.value, null, 'a comment alone makes the cell occupied but valueless');
});

test('dropdown rules, including the ones in the x14 extension, enter the comparison but not the options', () => {
  const file = workbook(`${head}<worksheet ${ns} xmlns:x14="u" xmlns:xm="v"><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData>`
    + '<dataValidations count="1"><dataValidation type="list" allowBlank="1" sqref="A2:A9 C2:C3"><formula1>"x,y"</formula1></dataValidation></dataValidations>'
    + '<extLst><ext uri="u"><x14:dataValidations count="1"><x14:dataValidation type="list"><x14:formula1><xm:f>Sheet2!$A$1:$A$3</xm:f></x14:formula1><xm:sqref>B2:B9</xm:sqref></x14:dataValidation></x14:dataValidations></ext></extLst></worksheet>');
  const sheet = readWorkbook(file).sheets[0]!;
  assert.equal(sheet.rules.length, 2);
  assert.deepEqual(sheet.rules.map(r => [r.ext, r.formula1, r.ranges.map(String)]), [[false, '"x,y"', ['A2:A9', 'C2:C3']], [true, 'Sheet2!$A$1:$A$3', ['B2:B9']]]);
  const snap = new Snapshot(file);
  assert.equal((validationProjection(snap) as unknown[][]).length, 3, 'one interval group per column and rule');
  assert.equal((validationProjection(snap, ['表一', new CellRange('A2:C4')]) as unknown[][]).length, 2, 'rows inside the append area drop out');
});

test('files that are not workbooks, or that could hurt, are refused', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gof-xlsx-'));
  const write = (name: string, data: Buffer | string) => { const f = path.join(dir, name); fs.writeFileSync(f, data); return f; };
  assert.throws(() => readWorkbook(write('a.xlsx', 'not a zip')), Blocked);
  assert.throws(() => readWorkbook(write('b.xlsx', zip({ 'other.txt': 'x' }))), /workbook\.xml/);
  assert.throws(() => new Snapshot(write('c.csv', 'a,b')), /XLSX/);
  const bomb = write('d.xlsx', zip({ 'xl/workbook.xml': 'x'.repeat(10) }));
  const data = fs.readFileSync(bomb);
  data.writeUInt32LE(0x7fffffff, data.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 24);
  assert.throws(() => new ZipReader(data).read('xl/workbook.xml'), /过大/);
  assert.equal(new ZipReader(zip({ 'a.txt': 'hello' }, false)).text('a.txt'), 'hello');
  assert.throws(() => parseXml('<a><b></a>'), /标签不匹配/);
  assert.throws(() => parseXml('<a>'), /未闭合/);
  assert.equal(parseXml('<a x="&lt;1&#65;&#x42;">&amp;<![CDATA[<z>]]></a>').attrs.x, '<1AB');
  assert.equal(parseXml('<!DOCTYPE a [<!ENTITY e "boom">]><a>&e;</a>').text, '&e;', 'custom entities are not expanded');
});

test('A1 arithmetic and formula filling', () => {
  assert.deepEqual([columnLetter(1), columnLetter(26), columnLetter(27), columnLetter(702), columnLetter(703)], ['A', 'Z', 'AA', 'ZZ', 'AAA']);
  assert.equal(columnIndex('AAA'), 703);
  assert.equal(new CellRange('B2:A1').toString(), 'A1:B2');
  assert.equal(new CellRange('C3:C3').toString(), 'C3');
  assert.equal(new CellRange('A1:C3').contains('B2'), true);
  assert.equal(new CellRange('A1:C3').contains('D2'), false);
  const formula = '=CONCATENATE("GOFCN",A5,"_A1_",$D5,"_",E$5,"_",$F$5,LOG10(B5),"x""A9",\'Sheet 1\'!C5)';
  assert.equal(translateFormula(formula, 'C5', 'C8'),
    '=CONCATENATE("GOFCN",A8,"_A1_",$D8,"_",E$5,"_",$F$5,LOG10(B8),"x""A9",\'Sheet 1\'!C8)');
  assert.equal(translateFormula('=A1+B2', 'C3', 'D5'), '=B3+C4');
  assert.throws(() => translateFormula('=A1', 'B2', 'A1'), /越界/);
});
