import path from 'node:path';
import { CellRange, columnLetter } from './a1.ts';
import { readWorkbook, type CellData, type RuleData, type SheetData, type WorkbookData } from './xlsx.ts';
import { Blocked, digest, need } from './util.ts';

export const FIELD_HEADERS: Record<string, string> = {
  number: '素材编号', keyword: '提炼词', name: '素材名称', primary_tag: '一级标签', secondary_tag: '二级标签',
  creative_form: '创意形式', client: '客户端', supplier: '供应商', creator: '创意者', creative_expression: '创意表达',
  creative_batch: '创意批次', head_reference: '片头引用', creative_reference: '创意引用',
};
export const REQUIRED_HEADERS = ['number', 'keyword', 'name', 'primary_tag', 'secondary_tag', 'creative_form', 'client', 'supplier', 'creator'];

/** A cell that holds something: a value, a comment or a link. Formatting alone does not count. */
export function hasContent(cell: CellData | undefined): boolean {
  return !!cell && (cell.value !== null || cell.comment !== null || cell.link !== null);
}

export function isText(cell: CellData | undefined): cell is CellData & { value: string } {
  return !!cell && cell.value !== null && (cell.kind === 's' || cell.kind === 'f' || cell.kind === 'e');
}

/** Does the cell hold exactly this expected value (a number for the material number, text otherwise)? */
export function holds(cell: CellData | undefined, expected: string | number): boolean {
  if (!cell || cell.value === null) return false;
  return typeof expected === 'number' ? cell.kind === 'n' && cell.value === String(expected) : isText(cell) && cell.value === expected;
}

export type Columns = Record<string, number>;

export class Snapshot {
  readonly path: string;
  readonly book: WorkbookData;
  readonly sheetNames: string[];
  readonly last: Record<string, number> = {};
  readonly cells: Record<string, Record<string, unknown>> = {};
  readonly meta: Record<string, unknown> = {};
  readonly rules: unknown[];
  readonly fingerprint: string;

  constructor(file: string) {
    this.path = path.resolve(file);
    need(this.path.toLowerCase().endsWith('.xlsx'), '保护检查必须使用 XLSX（包含公式），不是 CSV');
    this.book = readWorkbook(this.path);
    this.sheetNames = this.book.sheets.map(s => s.name);
    for (const ws of this.book.sheets) {
      const data: Record<string, unknown> = {};
      let last = 1;
      for (const cell of ws.cells.values()) {
        if (hasContent(cell)) last = Math.max(last, cell.row);
        if (hasContent(cell) || cell.style !== null) {
          data[cell.coord] = {
            value: cell.value, type: cell.value !== null ? cell.kind : null, style: cell.style,
            comment: cell.comment, link: cell.link,
          };
        }
      }
      this.cells[ws.name] = data;
      this.last[ws.name] = last;
      this.meta[ws.name] = {
        state: ws.state, merges: ws.merges, rows: ws.rows, columns: ws.columns, filter: ws.filter, protection: ws.protection,
      };
    }
    this.rules = validationProjection(this);
    this.fingerprint = digest({ cells: this.cells, meta: this.meta, rules: this.rules, order: this.sheetNames });
  }

  sheet(name: string): SheetData {
    const found = this.book.sheets.find(s => s.name === name);
    need(found, `工作表不存在：${name}`);
    return found;
  }

  cell(sheet: string, row: number, col: number): CellData | undefined {
    return this.sheet(sheet).cells.get(`${columnLetter(col)}${row}`);
  }

  close(): void { /* nothing is held open */ }
}

/** Compares per-column union intervals of the dropdown rules, independent of how a rule was split or ordered. */
export function validationProjection(snapshot: Snapshot, allowed?: [string, CellRange]): unknown[] {
  const result: unknown[] = [];
  for (const ws of snapshot.book.sheets) {
    const buckets = new Map<string, { col: number; signature: string; ranges: [number, number][] }>();
    for (const rule of ws.rules) {
      for (const rect of rule.ranges) {
        for (let col = rect.minCol; col <= rect.maxCol; col++) {
          let ranges: [number, number][] = [[rect.minRow, rect.maxRow]];
          if (allowed && allowed[0] === ws.name && allowed[1].minCol <= col && col <= allowed[1].maxCol) {
            const a = allowed[1];
            ranges = [];
            if (rect.minRow < a.minRow) ranges.push([rect.minRow, Math.min(rect.maxRow, a.minRow - 1)]);
            if (rect.maxRow > a.maxRow) ranges.push([Math.max(rect.minRow, a.maxRow + 1), rect.maxRow]);
          }
          const key = `${col}\u0000${rule.signature}`;
          let bucket = buckets.get(key);
          if (!bucket) { bucket = { col, signature: rule.signature, ranges: [] }; buckets.set(key, bucket); }
          bucket.ranges.push(...ranges.filter(([lo, hi]) => lo <= hi));
        }
      }
    }
    const ordered = [...buckets.values()].sort((x, y) => x.col - y.col || (x.signature < y.signature ? -1 : x.signature > y.signature ? 1 : 0));
    for (const bucket of ordered) {
      if (bucket.ranges.length === 0) continue;
      const merged: [number, number][] = [];
      for (const [lo, hi] of [...bucket.ranges].sort((p, q) => p[0] - q[0] || p[1] - q[1])) {
        const tail = merged[merged.length - 1];
        if (tail && lo <= tail[1] + 1) tail[1] = Math.max(hi, tail[1]);
        else merged.push([lo, hi]);
      }
      result.push([ws.name, bucket.col, bucket.signature, merged]);
    }
  }
  return result;
}

export function columns(ws: SheetData): Columns {
  const result: Columns = {};
  for (let col = 1; col <= ws.maxCol; col++) {
    const header = ws.cells.get(`${columnLetter(col)}1`);
    const text = (header?.value ?? '').replace(/\s+/g, '');
    for (const [field, stem] of Object.entries(FIELD_HEADERS)) {
      let matched = field === 'supplier' ? text.includes(stem) : text.startsWith(stem);
      if (field === 'creator') matched = [stem, '审核人', '脚本审核人'].some(h => text.startsWith(h));
      if (matched) {
        need(!(field in result), `${ws.name} 的 ${stem} 表头不唯一`);
        result[field] = col;
      }
    }
  }
  need(REQUIRED_HEADERS.every(f => f in result), `${ws.name} 不是完整创意进度表`);
  return result;
}

export function candidates(snapshot: Snapshot): Record<string, Columns> {
  const result: Record<string, Columns> = {};
  for (const ws of snapshot.book.sheets) {
    if (!ws.name.toUpperCase().includes('GOFCN')) continue;
    try { result[ws.name] = columns(ws); } catch (error) { if (!(error instanceof Blocked)) throw error; }
  }
  need(Object.keys(result).length > 0, '找不到完整 GOFCN 进度工作表');
  return result;
}

export function sheetPeriod(name: string): [number, number] | undefined {
  const m = /(\d{2,4})年(\d{1,2})月(?:\s*[-至]\s*(\d{1,2})月)?/.exec(name);
  if (!m) return undefined;
  let year = Number(m[1]);
  const month = Number(m[3] ?? m[2]);
  if (year < 100) year += 2000;
  return month >= 1 && month <= 12 ? [year, month] : undefined;
}

export function chooseSheet(snapshot: Snapshot, request: { worksheet?: string }, current: string | null | undefined): [string, Record<string, Columns>] {
  const tables = candidates(snapshot);
  const explicit = request.worksheet || current;
  if (explicit) {
    need(explicit in tables, '指定/当前工作表不存在或列结构不匹配，请澄清');
    return [explicit, tables];
  }
  const dated = Object.keys(tables).flatMap(name => { const p = sheetPeriod(name); return p ? [{ p, name }] : []; });
  need(dated.length > 0, '没有可识别年月的工作表，请指定');
  const key = (p: [number, number]) => p[0] * 100 + p[1];
  const latest = Math.max(...dated.map(d => key(d.p)));
  const names = dated.filter(d => key(d.p) === latest).map(d => d.name);
  need(names.length === 1, '最新工作表有并列，请指定');
  return [names[0]!, tables];
}

export function collectIds(snapshot: Snapshot, tables: Record<string, Columns>, warnings: string[] = []): Map<number, [string, number]> {
  const identifiers = new Map<number, [string, number]>();
  for (const [name, cols] of Object.entries(tables)) {
    for (let r = 2; r <= snapshot.last[name]!; r++) {
      const raw = snapshot.cell(name, r, cols.number!);
      const existing = snapshot.cell(name, r, cols.name!);
      const rawText = raw?.value ?? null;
      let number: number | null = null;
      if (rawText !== null && rawText !== '') {
        need(raw!.kind !== 'b' && /^\d+$/.test(rawText), `${name}!${r} 有非法素材编号`);
        number = Number(rawText);
        need(number > 0, '现有素材编号必须为正数');
      }
      const existingName = isText(existing) ? existing.value : null;
      const literal = existingName !== null ? /^GOFCN(\d+)(?:_|$)/.exec(existingName) : null;
      if (literal) {
        const named = Number(literal[1]);
        if (number !== null && named !== number) {
          warnings.push(`历史编号与名称不一致：${name}!${r}，两者均保留并参与避让`);
          if (!identifiers.has(named)) identifiers.set(named, [name, r]);
        } else number = named;
      }
      if (existingName !== null && existingName.startsWith('=') && (rawText === null || rawText === '')) {
        // An existing naming formula without a number cannot be assigned safely.
        need(!existingName.toUpperCase().includes('"GOFCN"'), `${name}!${r} 有缺失编号的命名公式`);
      }
      if (number !== null) {
        const seen = identifiers.get(number);
        if (seen) warnings.push(`历史编号重复：${number}，${seen[0]}!${seen[1]} / ${name}!${r}；不修改`);
        else identifiers.set(number, [name, r]);
      }
    }
  }
  need(identifiers.size > 0, '没有可继续的 GOFCN 编号，请澄清起始编号');
  return identifiers;
}

export function concatenate(formula: string, rowValues: Record<string, string | number | null>): string {
  const m = /^=(?:CONCATENATE|CONCAT)\((.*)\)$/i.exec(formula);
  need(m, '命名公式不是受支持的 CONCATENATE/CONCAT，不能推测');
  const body = m[1]!;
  const tokens = body.match(/"(?:[^"]|"")*"|\$?[A-Z]+\$?\d+|,/gi) ?? [];
  const cleaned = body.replace(/"(?:[^"]|"")*"|\s+/g, match => /^\s/.test(match) ? '' : match);
  need(tokens.join('') === cleaned, '命名公式含未支持的表达式');
  need(tokens.length > 0 && tokens.length % 2 === 1 && tokens.every((t, i) => i % 2 === 0 || t === ','), '命名公式参数格式不支持');
  const output: string[] = [];
  for (let i = 0; i < tokens.length; i += 2) {
    const token = tokens[i]!;
    if (token.startsWith('"')) output.push(token.slice(1, -1).replaceAll('""', '"'));
    else {
      const coord = token.replaceAll('$', '').toUpperCase();
      need(coord in rowValues, '命名公式引用本批未批准的字段或跨行引用');
      const value = rowValues[coord];
      output.push(value === null || value === undefined ? '' : String(value));
    }
  }
  return output.join('');
}

export function inlineOptions(rule: RuleData): string[] {
  const f = rule.formula1 ?? '';
  need(rule.type === 'list' && f.startsWith('"') && f.endsWith('"') && f.length >= 2, '下拉选项来源不是可可靠保留的自定义列表');
  return f.slice(1, -1).replaceAll('""', '"').split(',');
}

/** Rules a spreadsheet application would show; the x14 extension block is compared in the fingerprint but never read for options. */
export function plainRules(ws: SheetData): RuleData[] {
  return ws.rules.filter(rule => !rule.ext);
}

export function optionsFor(ws: SheetData, col: number, last: number): string[] {
  const found: [number, RuleData][] = [];
  for (const rule of plainRules(ws)) {
    for (const area of rule.ranges) {
      if (area.minCol <= col && col <= area.maxCol && area.minRow <= last) found.push([Math.min(last, area.maxRow), rule]);
    }
  }
  if (found.length === 0) return [];
  const nearest = Math.max(...found.map(([end]) => end));
  const options: string[] = [];
  for (const [end, rule] of found) {
    if (end === nearest) for (const value of inlineOptions(rule)) if (!options.includes(value)) options.push(value);
  }
  return options;
}
