import { DOC_EDIT_SCOPE } from '../config.ts';
import { docTarget } from './brief.ts';
import { target, type Bridge } from './feishu.ts';
import { Blocked, canonical, digest, isObject, need, NODE } from './util.ts';

/*
 * Writing into a Feishu requirement document the user links to, as the user: a docx gets new blocks (headings, text, lists, tables) at
 * a place in its top level, or text in empty table cells; a sheet tab gets text in empty cells. Nothing that is in the document already
 * is changed, moved or deleted: a cell that holds anything is refused, and every write is read back. A place is given by the index the
 * outline showed together with what the outline showed there, so a document edited in the meantime cannot take the text somewhere else.
 * The progress sheet has its own append (feishu append) and is never edited here.
 *
 * Running the same edit again is safe: it reads the document first and reports what it finds already there instead of writing it twice.
 */

type Obj = Record<string, any>;

const TYPE_NAMES: Record<number, string> = {
  1: 'page', 2: 'text', 3: 'heading1', 4: 'heading2', 5: 'heading3', 6: 'heading4', 7: 'heading5', 8: 'heading6', 9: 'heading7', 10: 'heading8',
  11: 'heading9', 12: 'bullet', 13: 'ordered', 14: 'code', 15: 'quote', 17: 'todo', 18: 'bitable', 19: 'callout', 22: 'divider', 23: 'file',
  24: 'grid', 25: 'grid_column', 27: 'image', 30: 'sheet', 31: 'table', 32: 'table_cell', 33: 'view', 34: 'quote_container',
};
/** The blocks an edit can create, by the name the edit file uses: the text kinds carry their text under that name. */
const TEXT_KINDS: Record<string, number> = { text: 2, heading1: 3, heading2: 4, heading3: 5, bullet: 12, ordered: 13 };
const SHOWN = 120;
const CELL_SHOWN = 60;
/** Rows of a table the outline shows (header included); `--block` shows one block whole. */
const OUTLINE_ROWS = 4;
const MAX_TOP = 50;
const MAX_CELLS = 100;

const clip = (text: string, limit: number) => ([...text].length > limit ? `${[...text].slice(0, limit).join('')}…` : text);
const typeOf = (block: Obj) => TYPE_NAMES[block.block_type] ?? `type${block.block_type}`;

/** The text of a block's own elements: text runs, mentioned documents by title, equations. Inline files and pictures count as content. */
function ownText(block: Obj): string {
  const body = block[typeOf(block)];
  if (!isObject(body) || !Array.isArray(body.elements)) return '';
  return (body.elements as Obj[]).map(e => e.text_run?.content ?? e.mention_doc?.title ?? e.equation?.content ?? (e.mention_user ? '@' : '[附件]')).join('');
}

class Doc {
  readonly revision: number;
  readonly title: string;
  readonly byId: Map<string, Obj>;
  readonly page: Obj;

  constructor(revision: number, title: string, blocks: Obj[]) {
    this.revision = revision;
    this.title = title;
    this.byId = new Map(blocks.map(b => [String(b.block_id), b]));
    const pages = blocks.filter(b => b.block_type === 1);
    need(pages.length === 1, '文档结构无法识别（没有唯一的页面块）');
    this.page = pages[0]!;
  }

  get top(): Obj[] { return ((this.page.children ?? []) as string[]).map(id => this.block(id)); }

  block(id: string): Obj {
    const found = this.byId.get(id);
    need(found, '文档结构不完整（子块缺失），稍后再读');
    return found;
  }

  /** Everything a block shows, children included, as one line of text. */
  deep(block: Obj): string {
    const type = typeOf(block);
    const own = type === 'image' ? '[图片]' : type === 'file' ? `[文件:${block.file?.name ?? ''}]` : type === 'table' ? '' : ownText(block);
    const inner = type === 'table' ? this.rows(block).map(r => r.map(c => c ?? '').join(' | ')).join(' / ')
      : ((block.children ?? []) as string[]).map(id => this.deep(this.block(id))).filter(Boolean).join(' ');
    return [own, inner].filter(Boolean).join(' ');
  }

  /** A table's cells by row, each as the text it shows; a cell hidden under a merged one is null. */
  rows(table: Obj): (string | null)[][] {
    const { rows, cols, cells, covered } = this.grid(table);
    return Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => (covered.has(r * cols + c) ? null : this.deep(this.block(cells[r * cols + c]!)))));
  }

  grid(table: Obj): { rows: number; cols: number; cells: string[]; covered: Set<number> } {
    const property = table.table?.property ?? {};
    const rows = Number(property.row_size);
    const cols = Number(property.column_size);
    const cells: string[] = table.table?.cells ?? table.children ?? [];
    need(Number.isInteger(rows) && Number.isInteger(cols) && rows > 0 && cols > 0 && cells.length === rows * cols, '表格结构无法识别');
    const covered = new Set<number>();
    ((property.merge_info ?? []) as Obj[]).forEach((span, i) => {
      const [r, c] = [Math.floor(i / cols), i % cols];
      for (let dr = 0; dr < (span.row_span ?? 1); dr++) for (let dc = 0; dc < (span.col_span ?? 1); dc++) if (dr || dc) covered.add((r + dr) * cols + c + dc);
    });
    return { rows, cols, cells, covered };
  }

  /** What the outline shows for a top-level block, and what an edit names it by: its text, or a table's first row. */
  shown(block: Obj): string {
    if (typeOf(block) === 'table') return clip(this.rows(block)[0]!.map(c => c ?? '').join(' | '), SHOWN);
    return clip(this.deep(block), SHOWN);
  }
}

async function readDoc(bridge: Bridge, id: string): Promise<Doc> {
  const read = await bridge.docxBlocks(id);
  return new Doc(read.revision, read.title, read.blocks);
}

/** A docx link resolved to its document; a sheet or another kind is refused for what it is. */
async function docxOf(bridge: Bridge, url: string): Promise<{ id: string; title: string }> {
  const found = await docTarget(bridge, url);
  need(found.type === 'docx', found.type === 'sheet' ? '这是表格：表格只能填空单元格（fill.sheet）' : `暂不支持编辑这种飞书文档（${found.type}）`);
  return { id: found.token, title: found.title };
}

/**
 * The top level of a docx as the agent picks a place from it: each block's index, kind and text (a table's first row), and a table's
 * first rows (cells clipped). `block` gives that one block whole, every cell unclipped; `full`, the whole document so. Read-only.
 */
export async function outline(bridge: Bridge, url: string, options: { full?: boolean; block?: number } = {}): Promise<Obj> {
  const { id, title } = await docxOf(bridge, url);
  const doc = await readDoc(bridge, id);
  const top = doc.top;
  const one = options.block;
  need(one === undefined || (Number.isInteger(one) && one >= 0 && one < top.length), `文档只有 ${top.length} 个顶层块（序号从 0 数）`);
  const whole = options.full === true || one !== undefined;
  const blocks = top.flatMap((block, index) => {
    if (one !== undefined && index !== one) return [];
    const entry: Obj = { index, type: typeOf(block), text: doc.shown(block) };
    if (entry.type === 'table') {
      const rows = doc.rows(block);
      const shown = whole ? rows : rows.slice(0, OUTLINE_ROWS).map(r => r.map(c => (c === null ? c : clip(c, CELL_SHOWN))));
      Object.assign(entry, { rows: rows.length, cols: rows[0]!.length, cells: shown, ...(shown.length < rows.length ? { more_rows: rows.length - shown.length } : {}) });
    }
    return [entry];
  });
  return { status: 'outline', kind: 'docx', title: title || doc.title, url, revision: doc.revision, top_blocks: top.length, blocks };
}

// ---- the edit file ------------------------------------------------------------------------------------------------------------

interface Run { text: string; bold?: boolean; link?: string }
type Planned = { kind: string; runs?: Run[]; cells?: string[][]; widths?: number[]; header?: boolean };

function runsOf(value: unknown, where: string): Run[] {
  const list = typeof value === 'string' ? [{ text: value }] : value;
  need(Array.isArray(list) && list.length > 0, `${where}的文字需要是文本，或 [{text, bold?, link?}]`);
  return list.map((run: unknown) => {
    need(isObject(run) && Object.keys(run).every(k => ['text', 'bold', 'link'].includes(k)) && typeof run.text === 'string', `${where}的文字段格式不对`);
    need(run.bold === undefined || typeof run.bold === 'boolean', `${where}的 bold 只能是 true/false`);
    need(run.link === undefined || (typeof run.link === 'string' && /^https?:\/\/\S+$/.test(run.link)), `${where}的链接需要是 http(s) 地址`);
    need(!/[\u0000-\u0008\u000b-\u001f]/.test(run.text) && [...run.text].length <= 5000, `${where}的文字含控制字符或过长`);
    return { text: run.text, ...(run.bold ? { bold: true } : {}), ...(run.link ? { link: run.link } : {}) };
  });
}

function plannedBlock(spec: unknown, where: string): Planned {
  need(isObject(spec), `${where}需要是对象`);
  const keys = Object.keys(spec);
  if ('table' in spec) {
    need(keys.every(k => ['table', 'widths', 'header'].includes(k)), `${where}的表格只接受 table、widths、header`);
    const rows = spec.table;
    need(Array.isArray(rows) && rows.length > 0 && rows.every(r => Array.isArray(r) && r.length > 0 && r.length === rows[0].length
      && r.every((c: unknown) => typeof c === 'string')), `${where}的表格需要是行的数组，每行同样多个文本单元格`);
    need(rows.length * rows[0].length <= 400, `${where}的表格超过 400 个单元格`);
    const widths = spec.widths;
    need(widths === undefined || (Array.isArray(widths) && widths.length === rows[0].length && widths.every((w: unknown) => Number.isInteger(w) && (w as number) >= 50 && (w as number) <= 1300)),
      `${where}的 widths 需要每列一个 50-1300 的整数`);
    need(spec.header === undefined || typeof spec.header === 'boolean', `${where}的 header 只能是 true/false`);
    for (const row of rows) for (const cell of row) runsOf(cell, where);
    return { kind: 'table', cells: rows, ...(widths ? { widths } : {}), ...(spec.header ? { header: true } : {}) };
  }
  need(keys.length === 1, `${where}只能有一个类型：${[...Object.keys(TEXT_KINDS), 'divider', 'table'].join('、')}`);
  const kind = keys[0]!;
  if (kind === 'divider') return { kind };
  need(kind in TEXT_KINDS, `${where}的类型“${kind}”不支持：${[...Object.keys(TEXT_KINDS), 'divider', 'table'].join('、')}`);
  return { kind, runs: runsOf(spec[kind], where) };
}

/** What the outline will show for a planned block once it is in: compared with the document to tell whether it is there already. */
function plannedShown(p: Planned): string {
  if (p.kind === 'table') return clip(p.cells![0]!.join(' | '), SHOWN);
  return clip((p.runs ?? []).map(r => r.text).join(''), SHOWN);
}

/** Does a block of the document show exactly a planned one: the kind, the text, and a table cell by cell. */
function holds(doc: Doc, block: Obj, p: Planned): boolean {
  if (typeOf(block) !== p.kind || doc.shown(block) !== plannedShown(p)) return false;
  return p.kind !== 'table' || canonical(doc.rows(block)) === canonical(p.cells);
}

function elements(runs: Run[]): Obj[] {
  return runs.map(r => ({ text_run: { content: r.text, ...(r.bold || r.link
    ? { text_element_style: { ...(r.bold ? { bold: true } : {}), ...(r.link ? { link: { url: encodeURIComponent(r.link) } } : {}) } } : {}) } }));
}

/** The descendants request for planned blocks: temporary IDs, tables with a text block in every cell. */
function descendants(planned: Planned[]): { top: string[]; all: Obj[] } {
  let n = 0;
  const next = (kind: string) => `${kind}_${++n}`;
  const all: Obj[] = [];
  const text = (kind: string, runs: Run[]) => {
    const id = next(kind);
    all.push({ block_id: id, block_type: TEXT_KINDS[kind], [kind]: { elements: elements(runs), style: {} }, children: [] });
    return id;
  };
  const top = planned.map(p => {
    if (p.kind === 'divider') {
      const id = next('divider');
      all.push({ block_id: id, block_type: 22, divider: {}, children: [] });
      return id;
    }
    if (p.kind !== 'table') return text(p.kind, p.runs!);
    const id = next('table');
    const entry: Obj = { block_id: id, block_type: 31, children: [] as string[],
      table: { property: { row_size: p.cells!.length, column_size: p.cells![0]!.length, ...(p.widths ? { column_width: p.widths } : {}), ...(p.header ? { header_row: true } : {}) } } };
    all.push(entry);
    for (const row of p.cells!) {
      for (const cell of row) {
        const cellId = next('cell');
        entry.children.push(cellId);
        all.push({ block_id: cellId, block_type: 32, table_cell: {}, children: [text('text', runsOf(cell, '单元格'))] });
      }
    }
    return id;
  });
  return { top, all };
}

/** The same request made again gets the same identifier, which Feishu takes as the same write. */
function clientToken(value: unknown): string {
  const h = digest(value);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** A top-level block an edit names: by the index the outline showed, with the text it showed; if the document moved, the one block with that text. */
function locate(doc: Doc, where: unknown, label: string): number {
  need(isObject(where) && Number.isInteger(where.index) && where.index >= 0 && typeof where.expect === 'string', `${label}需要 {index, expect}：大纲里的序号和那里显示的文字`);
  const top = doc.top;
  if (where.index < top.length && doc.shown(top[where.index]!) === where.expect) return where.index;
  const found = top.flatMap((b, i) => (doc.shown(b) === where.expect ? [i] : []));
  need(found.length === 1, found.length === 0
    ? `${label}：文档里第 ${where.index} 块已不是“${where.expect}”，也找不到它；重新读大纲再定位置`
    : `${label}：文档里第 ${where.index} 块已变，“${where.expect}”有 ${found.length} 处；重新读大纲再定位置`);
  return found[0]!;
}

/** Feishu's refusals of an edit, said the way the user can act on them. */
async function writing<T>(send: () => Promise<T>): Promise<T> {
  try { return await send(); } catch (error) {
    const text = (error as Error).message;
    if (/1770032|HTTP 403|forbidden/i.test(text)) throw new Blocked(`没有这份文档的编辑权限：请文档所有者给你开编辑权限（${text}）`);
    if (/写入结果未知/.test(text)) throw new Blocked('文档写入结果未知：再运行一次同样的 doc-edit，它会先回读，内容已在就不会再写');
    throw error;
  }
}

/** Logins made before documents could be edited lack the permission: the user authorizes once more (the same QR as a first login). */
async function canEdit(bridge: Bridge): Promise<void> {
  const checked = await bridge.call('auth-check-scopes', { required: [DOC_EDIT_SCOPE] });
  need(checked.complete === true && !(checked.missing ?? []).length,
    '飞书登录还没有编辑文档的权限：让用户重新扫码授权一次（gof feishu login start，再 gof feishu authorize --qr …），之后再写');
}

// ---- docx -------------------------------------------------------------------------------------------------------------------

async function insertBlocks(bridge: Bridge, url: string, spec: unknown, check: boolean): Promise<Obj> {
  need(isObject(spec) && Object.keys(spec).every(k => ['at', 'blocks'].includes(k)), 'insert 只接受 at、blocks');
  const list = spec.blocks;
  need(Array.isArray(list) && list.length > 0 && list.length <= MAX_TOP, `insert.blocks 需要 1-${MAX_TOP} 个块`);
  const planned = list.map((b: unknown, i: number) => plannedBlock(b, `第 ${i + 1} 块`));
  const { id, title } = await docxOf(bridge, url);
  if (!check) await canEdit(bridge);
  const doc = await readDoc(bridge, id);
  const top = doc.top;
  const at = spec.at;
  // Where the blocks go, and where they are if they went in already (an edit run a second time): before the anchor, after it, first, last.
  let index: number;
  let already: number;
  if (at === 'start') [index, already] = [0, 0];
  else if (at === 'end') [index, already] = [top.length, top.length - planned.length];
  else {
    need(isObject(at) && (('before' in at) !== ('after' in at)), 'insert.at 需要 "start"、"end"、{before: 序号, expect} 或 {after: 序号, expect}');
    const before = 'before' in at;
    const anchor = locate(doc, { index: before ? at.before : at.after, expect: at.expect }, 'insert.at');
    [index, already] = before ? [anchor, anchor - planned.length] : [anchor + 1, anchor + 1];
  }
  const result: Obj = { kind: 'docx', title: title || doc.title, url, index, blocks: planned.length, preview: planned.map(p => `${p.kind}: ${plannedShown(p)}`) };
  if (already >= 0 && already + planned.length <= top.length && planned.every((p, i) => holds(doc, top[already + i]!, p))) {
    return { status: 'already_present', ...result, index: already, revision: doc.revision };
  }
  const { top: ids, all } = descendants(planned);
  need(all.length <= 1000, `这次插入有 ${all.length} 个块（含表格单元格），超过 1000 个；分几次插入`);
  if (check) return { status: 'edit_ready', ...result, revision: doc.revision };
  const reply = await writing(() => bridge.docxInsert({ document: id, parent: doc.page.block_id, index, children_id: ids, descendants: all,
    client_token: clientToken({ id, revision: doc.revision, index, all }) }));
  // Read back: the new blocks are next to each other in the top level, in order, showing what was planned (tables cell by cell).
  const relations = new Map(((reply?.block_id_relations ?? []) as Obj[]).map(r => [r.temporary_block_id, r.block_id]));
  const real = ids.map(t => relations.get(t));
  const after = await readDoc(bridge, id);
  const children: string[] = after.page.children ?? [];
  const start = real.every(Boolean) ? children.indexOf(real[0]!) : -1;
  const landed = start >= 0 && real.every((r, i) => children[start + i] === r) ? children.slice(start, start + ids.length).map(c => after.block(c)) : [];
  need(landed.length === planned.length && planned.every((p, i) => holds(after, landed[i]!, p)), '文档写入已发出，但回读与计划不符：先读大纲核对，不要重复插入');
  return { status: 'doc_updated', ...result, index: start, revision: after.revision };
}

/** The empty text block a cell holds (and nothing else), or undefined when it holds anything. */
function emptyText(doc: Doc, cell: Obj): Obj | undefined {
  const children = ((cell.children ?? []) as string[]).map(c => doc.block(c));
  if (children.length === 0 || !children.every(b => b.block_type === 2 && ((b.text?.elements ?? []) as Obj[]).every(e => e.text_run && e.text_run.content === ''))) return undefined;
  return children[0];
}

async function fillTable(bridge: Bridge, url: string, spec: Obj, check: boolean): Promise<Obj> {
  need(Object.keys(spec).every(k => ['table', 'expect', 'cells'].includes(k)), 'fill 只接受 table、expect、cells（表格）或 sheet、cells（电子表格）');
  const cells = spec.cells;
  need(Array.isArray(cells) && cells.length > 0 && cells.length <= MAX_CELLS, `fill.cells 需要 1-${MAX_CELLS} 个单元格`);
  const { id, title } = await docxOf(bridge, url);
  if (!check) await canEdit(bridge);
  const doc = await readDoc(bridge, id);
  const table = doc.top[locate(doc, { index: spec.table, expect: spec.expect }, 'fill.table')]!;
  need(typeOf(table) === 'table', 'fill.table 指的不是表格');
  const grid = doc.grid(table);
  const seen = new Set<number>();
  const todo: { at: number; text: string; block?: Obj; state: string }[] = cells.map((c: unknown, i: number) => {
    need(isObject(c) && Object.keys(c).every(k => ['row', 'col', 'text'].includes(k)) && typeof c.text === 'string' && c.text !== '', `第 ${i + 1} 个单元格需要 {row, col, text}`);
    need(Number.isInteger(c.row) && Number.isInteger(c.col) && c.row >= 0 && c.col >= 0 && c.row < grid.rows && c.col < grid.cols,
      `第 ${i + 1} 个单元格（${c.row},${c.col}）不在 ${grid.rows}×${grid.cols} 的表格里（行列从 0 数）`);
    const at = c.row * grid.cols + c.col;
    need(!seen.has(at), `单元格（${c.row},${c.col}）写了两次`);
    seen.add(at);
    need(!grid.covered.has(at), `单元格（${c.row},${c.col}）被合并在别的单元格下，写不了`);
    runsOf(c.text, `单元格（${c.row},${c.col}）`);
    const cell = doc.block(grid.cells[at]!);
    const shown = doc.deep(cell);
    if (shown === c.text) return { at, text: c.text, state: 'same' };
    const block = emptyText(doc, cell);
    need(block, `单元格（${c.row},${c.col}）已有内容“${clip(shown, 40)}”，不覆盖`);
    return { at, text: c.text, block, state: 'empty' };
  });
  const result: Obj = { kind: 'docx', title: title || doc.title, url, table: doc.top.indexOf(table), cells: todo.length,
    to_write: todo.filter(t => t.state === 'empty').length, already: todo.filter(t => t.state === 'same').length };
  const writes = todo.filter(t => t.state === 'empty');
  if (writes.length === 0) return { status: 'already_present', ...result, revision: doc.revision };
  if (check) return { status: 'edit_ready', ...result, revision: doc.revision };
  const updates = writes.map(t => ({ block_id: t.block!.block_id, elements: elements(runsOf(t.text, '单元格')) }));
  await writing(() => bridge.docxSetTexts({ document: id, updates, client_token: clientToken({ id, revision: doc.revision, updates }) }));
  const after = await readDoc(bridge, id);
  const again = after.byId.get(String(table.block_id));
  need(again && todo.every(t => after.deep(after.block(after.grid(again).cells[t.at]!)) === t.text), '文档写入已发出，但回读与计划不符：先读大纲核对');
  return { status: 'doc_updated', ...result, revision: after.revision };
}

// ---- sheet --------------------------------------------------------------------------------------------------------------------

const A1_CELL = /^([A-Z]{1,3})([1-9]\d{0,6})$/;

async function fillSheet(bridge: Bridge, url: string, spec: Obj, check: boolean): Promise<Obj> {
  need(Object.keys(spec).every(k => ['sheet', 'cells'].includes(k)), 'fill 只接受 sheet、cells（电子表格）');
  const cells = spec.cells;
  need(Array.isArray(cells) && cells.length > 0 && cells.length <= MAX_CELLS, `fill.cells 需要 1-${MAX_CELLS} 个单元格`);
  const found = await docTarget(bridge, url);
  need(found.type === 'sheet', found.type === 'docx' ? '这是文档：文档用 fill.table 或 insert' : `暂不支持编辑这种飞书文档（${found.type}）`);
  need(found.node !== NODE && found.token !== await target(bridge), '创意进度表只能用 gof feishu append 追加，不在这里编辑');
  const tabs = ((await bridge.apiRead(`/open-apis/sheets/v3/spreadsheets/${found.token}/sheets/query`)).sheets ?? []) as Obj[];
  const wanted = typeof spec.sheet === 'string' && spec.sheet !== '' ? spec.sheet : found.linked;
  need(wanted || tabs.length === 1, 'fill.sheet 需要写明工作表（名称或 sheet_id）');
  const tab = wanted ? tabs.find(t => t.sheet_id === wanted) ?? tabs.find(t => t.title === wanted) : tabs[0];
  need(tab, `表格里没有工作表“${wanted}”`);
  const seen = new Set<string>();
  const todo = cells.map((c: unknown, i: number) => {
    need(isObject(c) && Object.keys(c).every(k => ['cell', 'text'].includes(k)) && typeof c.cell === 'string' && typeof c.text === 'string' && c.text !== '',
      `第 ${i + 1} 个单元格需要 {cell, text}`);
    const cell = c.cell.toUpperCase();
    need(A1_CELL.test(cell), `第 ${i + 1} 个单元格“${c.cell}”需要写成 A5 这样的单个单元格`);
    need(!seen.has(cell), `单元格 ${cell} 写了两次`);
    seen.add(cell);
    need(!c.text.startsWith('=') && !/[\u0000-\u0008\u000b-\u001f]/.test(c.text), `单元格 ${cell} 的文字不能以 = 开头，也不能含控制字符`);
    return { cell, text: c.text };
  });
  const read = async () => {
    const data = await bridge.apiRead(`/open-apis/sheets/v2/spreadsheets/${found.token}/values_batch_get`,
      { ranges: todo.map(t => `${tab.sheet_id}!${t.cell}:${t.cell}`).join(','), valueRenderOption: 'ToString' });
    const ranges = data?.valueRanges;
    need(Array.isArray(ranges) && ranges.length === todo.length, '单元格读取返回结构不匹配');
    return ranges.map((r: Obj) => r.values?.[0]?.[0] ?? null);
  };
  const before = await read();
  const states = todo.map((t, i) => {
    const value = before[i];
    if (value === t.text) return 'same';
    need(value === null || value === '', `单元格 ${t.cell} 已有内容“${clip(String(value), 40)}”，不覆盖`);
    return 'empty';
  });
  const writes = todo.filter((_, i) => states[i] === 'empty');
  const result: Obj = { kind: 'sheet', title: found.title, url, sheet: tab.title, cells: todo.length, to_write: writes.length, already: todo.length - writes.length };
  if (writes.length === 0) return { status: 'already_present', ...result };
  if (check) return { status: 'edit_ready', ...result };
  // Each cell its own range, sent with allow_overwrite:false: Feishu itself refuses a cell that has been filled meanwhile.
  await writing(() => bridge.cellsSet(found.token, writes.map(t => ({ sheet_id: tab.sheet_id, range: `${t.cell}:${t.cell}`, cells: [[{ value: t.text }]], allow_overwrite: false }))));
  const after = await read();
  need(todo.every((t, i) => after[i] === t.text), '表格写入已发出，但回读与计划不符：先读表格核对');
  return { status: 'doc_updated', ...result };
}

/**
 * One edit of a requirement document (`gof feishu doc-edit`): {"insert": {at, blocks}} or {"fill": {table, expect, cells}} for a docx,
 * {"fill": {sheet, cells}} for a sheet. `check` resolves everything against the document as it is now and writes nothing.
 */
export async function editDoc(bridge: Bridge, url: string, edit: unknown, check = false): Promise<Obj> {
  need(isObject(edit) && Object.keys(edit).length === 1 && ('insert' in edit || 'fill' in edit), '编辑文件需要 {"insert": …} 或 {"fill": …} 其中之一');
  await bridge.doctor();
  if ('insert' in edit) return insertBlocks(bridge, url, edit.insert, check);
  need(isObject(edit.fill), 'fill 需要是对象');
  return 'table' in edit.fill ? fillTable(bridge, url, edit.fill, check) : fillSheet(bridge, url, edit.fill, check);
}
