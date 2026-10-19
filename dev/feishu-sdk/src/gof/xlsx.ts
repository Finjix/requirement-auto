import fs from 'node:fs';
import path from 'node:path';
import { CellRange, columnLetter, coordOf, parseCoord, translateFormula } from './a1.ts';
import { child, childrenOf, parseXml, toData, type XmlNode } from './xml.ts';
import { ZipReader } from './zip.ts';
import { canonical, digest, need } from './util.ts';

/**
 * A read-only model of an .xlsx, holding exactly what the append checks compare: cell values and kinds, the content of cell
 * styles, comments and links, merged ranges, row/column settings, the auto filter, sheet protection and the dropdown rules.
 * Nothing is ever written back, so there is no round trip that could drop or change a part of the workbook.
 */

export type CellKind = 'n' | 's' | 'b' | 'e' | 'f' | 'd';

export interface CellData {
  row: number;
  col: number;
  coord: string;
  /** The text as stored: strings, "=formula", or the number/boolean/error exactly as written in the file. */
  value: string | null;
  kind: CellKind | null;
  /** Digest of the style's content (font, fill, border, alignment, protection, number format); null for the default style. */
  style: string | null;
  comment: [string, string] | null;
  link: [string | null, string | null] | null;
}

export interface RuleData {
  type: string | null;
  /** Everything about the rule except where it applies. */
  signature: string;
  ranges: CellRange[];
  formula1: string | null;
  /** Declared in the x14 extension block instead of the main dataValidations element. */
  ext: boolean;
}

export interface SheetData {
  name: string;
  state: string;
  cells: Map<string, CellData>;
  maxRow: number;
  maxCol: number;
  merges: string[];
  rows: Record<string, unknown[]>;
  columns: Record<string, unknown[]>;
  filter: { ref: string | null; rest: string } | null;
  protection: string | null;
  protectedSheet: boolean;
  rules: RuleData[];
}

export interface WorkbookData {
  sheets: SheetData[];
}

const MAX_CELLS = 4_000_000;
const truthy = (value: string | undefined) => value === '1' || value === 'true';
const unescapeText = (text: string) => text.replace(/_x([0-9A-Fa-f]{4})_/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));

function richText(node: XmlNode | undefined): string {
  if (!node) return '';
  let out = '';
  for (const c of node.children) {
    if (c.name === 't') out += c.text;
    else if (c.name === 'r') out += c.children.filter(t => t.name === 't').map(t => t.text).join('');
  }
  return unescapeText(out);
}

function relationships(zip: ZipReader, file: string): Map<string, { target: string; external: boolean; type: string }> {
  const result = new Map<string, { target: string; external: boolean; type: string }>();
  if (!zip.has(file)) return result;
  for (const rel of childrenOf(parseXml(zip.text(file)), 'Relationship')) {
    if (rel.attrs.Id && rel.attrs.Target) result.set(rel.attrs.Id, { target: rel.attrs.Target, external: rel.attrs.TargetMode === 'External', type: rel.attrs.Type ?? '' });
  }
  return result;
}

function resolve(baseDir: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  return path.posix.normalize(path.posix.join(baseDir, target));
}

class Styles {
  private readonly fonts: (XmlNode | undefined)[] = [];
  private readonly fills: (XmlNode | undefined)[] = [];
  private readonly borders: (XmlNode | undefined)[] = [];
  private readonly xfs: XmlNode[] = [];
  private readonly formats = new Map<string, string>();
  private readonly cache = new Map<number, string>();
  private readonly base: string;

  constructor(xml: string | undefined) {
    if (xml !== undefined) {
      const root = parseXml(xml);
      for (const f of childrenOf(child(root, 'numFmts'), 'numFmt')) this.formats.set(f.attrs.numFmtId ?? '', f.attrs.formatCode ?? '');
      this.fonts = child(root, 'fonts')?.children ?? [];
      this.fills = child(root, 'fills')?.children ?? [];
      this.borders = child(root, 'borders')?.children ?? [];
      this.xfs = child(root, 'cellXfs')?.children ?? [];
    }
    this.base = this.compute(0);
  }

  private compute(index: number): string {
    const xf = this.xfs[index];
    if (!xf) return digest(null);
    const numFmtId = xf.attrs.numFmtId ?? '0';
    return digest({
      font: toData(this.fonts[Number(xf.attrs.fontId ?? 0)]),
      fill: toData(this.fills[Number(xf.attrs.fillId ?? 0)]),
      border: toData(this.borders[Number(xf.attrs.borderId ?? 0)]),
      alignment: toData(child(xf, 'alignment')),
      protection: toData(child(xf, 'protection')),
      numFmt: this.formats.get(numFmtId) ?? `builtin:${numFmtId}`,
    });
  }

  /** The content signature of cell format `index`, or null when it is the same as the default format. */
  signature(index: number | undefined): string | null {
    if (index === undefined || !Number.isInteger(index) || index < 0) return null;
    let sig = this.cache.get(index);
    if (sig === undefined) { sig = this.compute(index); this.cache.set(index, sig); }
    return sig === this.base ? null : sig;
  }
}

function dimensionStyle(styles: Styles, value: string | undefined): string | null {
  return value === undefined ? null : styles.signature(Number(value));
}

function readRule(node: XmlNode, ext: boolean): RuleData {
  const { sqref: attrRef, ...attrs } = node.attrs;
  const f1 = ext ? child(child(node, 'formula1'), 'f')?.text : child(node, 'formula1')?.text;
  const f2 = ext ? child(child(node, 'formula2'), 'f')?.text : child(node, 'formula2')?.text;
  const sqref = ext ? child(node, 'sqref')?.text ?? '' : attrRef ?? '';
  const ranges = sqref.split(/\s+/).filter(Boolean).map(part => new CellRange(part));
  return {
    type: node.attrs.type ?? null,
    signature: canonical({ ext, attrs, formula1: f1 ?? null, formula2: f2 ?? null }),
    ranges, formula1: f1 ?? null, ext,
  };
}

function readSheet(zip: ZipReader, file: string, name: string, state: string, styles: Styles, shared: string[]): SheetData {
  const root = parseXml(zip.text(file));
  need(root.name === 'worksheet', `${name} 不是有效的工作表`);
  const rels = relationships(zip, path.posix.join(path.posix.dirname(file), '_rels', `${path.posix.basename(file)}.rels`));
  const dir = path.posix.dirname(file);
  const cells = new Map<string, CellData>();
  const sharedFormulas = new Map<string, { coord: string; text: string }>();
  const rows: Record<string, unknown[]> = {};
  let maxRow = 0;
  let maxCol = 0;
  let rowCursor = 0;

  const ensure = (coord: string): CellData => {
    let cell = cells.get(coord);
    if (!cell) {
      const { col, row } = parseCoord(coord);
      cell = { row, col, coord, value: null, kind: null, style: null, comment: null, link: null };
      cells.set(coord, cell);
      maxRow = Math.max(maxRow, row);
      maxCol = Math.max(maxCol, col);
    }
    return cell;
  };

  for (const rowNode of childrenOf(child(root, 'sheetData'), 'row')) {
    const rowIndex = rowNode.attrs.r !== undefined ? Number(rowNode.attrs.r) : rowCursor + 1;
    need(Number.isInteger(rowIndex) && rowIndex >= 1 && rowIndex <= 1048576, `${name} 的行号无效`);
    rowCursor = rowIndex;
    const a = rowNode.attrs;
    if (['ht', 'hidden', 'outlineLevel', 'collapsed', 'customHeight', 'customFormat', 's', 'thickBot', 'thickTop'].some(k => k in a)) {
      rows[String(rowIndex)] = [a.ht ?? null, truthy(a.hidden), Number(a.outlineLevel ?? 0), truthy(a.collapsed),
        truthy(a.customFormat) ? dimensionStyle(styles, a.s) : null];
    }
    let colCursor = 0;
    for (const c of childrenOf(rowNode, 'c')) {
      const coord = c.attrs.r ?? coordOf(colCursor + 1, rowIndex);
      const cell = ensure(coord);
      colCursor = cell.col;
      cell.style = styles.signature(c.attrs.s === undefined ? undefined : Number(c.attrs.s));
      const f = child(c, 'f');
      const v = child(c, 'v')?.text;
      const t = c.attrs.t ?? 'n';
      if (f && (f.text !== '' || f.attrs.t === 'shared')) {
        let text = f.text;
        if (f.attrs.t === 'shared') {
          const key = f.attrs.si ?? '';
          if (text !== '') sharedFormulas.set(key, { coord, text });
          else {
            const master = sharedFormulas.get(key);
            need(master, `${name}!${coord} 的共享公式缺少主单元格`);
            text = translateFormula(master.text, master.coord, coord);
          }
        }
        cell.value = `=${text}`;
        cell.kind = 'f';
      } else if (t === 's') {
        if (v !== undefined && v !== '') {
          const text = shared[Number(v)];
          need(text !== undefined, `${name}!${coord} 引用了不存在的共享字符串`);
          cell.value = text;
          cell.kind = 's';
        }
      } else if (t === 'inlineStr') {
        cell.value = richText(child(c, 'is'));
        cell.kind = 's';
      } else if (t === 'str') {
        if (v !== undefined) { cell.value = unescapeText(v); cell.kind = 's'; }
      } else if (t === 'b' || t === 'e' || t === 'd') {
        if (v !== undefined && v !== '') { cell.value = v; cell.kind = t; }
      } else if (v !== undefined && v !== '') {
        cell.value = v.trim();
        cell.kind = 'n';
      }
    }
  }

  const columns: Record<string, unknown[]> = {};
  for (const col of childrenOf(child(root, 'cols'), 'col')) {
    const min = Number(col.attrs.min);
    const max = Number(col.attrs.max);
    need(Number.isInteger(min) && Number.isInteger(max) && min >= 1 && max >= min && max <= 16384, `${name} 的列设置无效`);
    columns[columnLetter(min)] = [min, max, col.attrs.width ?? null, truthy(col.attrs.hidden), Number(col.attrs.outlineLevel ?? 0),
      truthy(col.attrs.collapsed), dimensionStyle(styles, col.attrs.style)];
  }

  const merges = childrenOf(child(root, 'mergeCells'), 'mergeCell').map(m => new CellRange(m.attrs.ref ?? '').toString()).sort();

  const filterNode = child(root, 'autoFilter');
  let filter: SheetData['filter'] = null;
  if (filterNode) {
    const { ref, ...attrs } = filterNode.attrs;
    filter = { ref: ref ?? null, rest: canonical(toData({ ...filterNode, attrs })) };
  }
  const protectionNode = child(root, 'sheetProtection');

  // Comments and hyperlinks make a cell "occupied" even when it has no value.
  for (const rel of rels.values()) {
    if (rel.external || !rel.type.endsWith('/comments')) continue;
    const commentsFile = resolve(dir, rel.target);
    if (!zip.has(commentsFile)) continue;
    const comments = parseXml(zip.text(commentsFile));
    const authors = childrenOf(child(comments, 'authors'), 'author').map(a => a.text);
    for (const comment of childrenOf(child(comments, 'commentList'), 'comment')) {
      const ref = comment.attrs.ref;
      if (!ref) continue;
      ensure(ref).comment = [authors[Number(comment.attrs.authorId ?? 0)] ?? '', richText(child(comment, 'text'))];
    }
  }
  for (const link of childrenOf(child(root, 'hyperlinks'), 'hyperlink')) {
    const rel = link.attrs.id ? rels.get(link.attrs.id) : undefined;
    const value: [string | null, string | null] = [rel?.target ?? null, link.attrs.location ?? null];
    const range = new CellRange(link.attrs.ref ?? '');
    need((range.maxCol - range.minCol + 1) * (range.maxRow - range.minRow + 1) <= 10_000, `${name} 的超链接范围过大`);
    for (let r = range.minRow; r <= range.maxRow; r++) {
      for (let col = range.minCol; col <= range.maxCol; col++) ensure(coordOf(col, r)).link = value;
    }
  }

  const rules = childrenOf(child(root, 'dataValidations'), 'dataValidation').map(n => readRule(n, false));
  for (const ext of childrenOf(child(root, 'extLst'), 'ext')) {
    for (const n of childrenOf(child(ext, 'dataValidations'), 'dataValidation')) rules.push(readRule(n, true));
  }

  return {
    name, state, cells, maxRow, maxCol, merges, rows, columns, filter,
    protection: protectionNode ? canonical(protectionNode.attrs) : null,
    protectedSheet: truthy(protectionNode?.attrs.sheet),
    rules,
  };
}

export function readWorkbook(file: string): WorkbookData {
  const zip = new ZipReader(fs.readFileSync(file));
  need(zip.has('xl/workbook.xml'), '不是有效的 XLSX：缺少 xl/workbook.xml');
  const book = parseXml(zip.text('xl/workbook.xml'));
  const rels = relationships(zip, 'xl/_rels/workbook.xml.rels');
  const shared = zip.has('xl/sharedStrings.xml')
    ? childrenOf(parseXml(zip.text('xl/sharedStrings.xml')), 'si').map(richText) : [];
  const styles = new Styles(zip.has('xl/styles.xml') ? zip.text('xl/styles.xml') : undefined);
  const sheets: SheetData[] = [];
  let cells = 0;
  for (const s of childrenOf(child(book, 'sheets'), 'sheet')) {
    const name = s.attrs.name;
    const rel = s.attrs.id ? rels.get(s.attrs.id) : undefined;
    need(name && rel && !rel.external, '工作簿的工作表清单无效');
    need(!sheets.some(x => x.name === name), `工作表名称重复：${name}`);
    const sheet = readSheet(zip, resolve('xl', rel.target), name, s.attrs.state ?? 'visible', styles, shared);
    need(sheet.maxRow * sheet.maxCol <= MAX_CELLS, `${name} 的扫描范围过大，不能证明安全`);
    cells += sheet.cells.size;
    sheets.push(sheet);
  }
  need(sheets.length > 0, 'XLSX 没有工作表');
  need(cells <= MAX_CELLS, 'XLSX 单元格过多，不能证明安全');
  return { sheets };
}
