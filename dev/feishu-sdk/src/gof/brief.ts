import { columnLetter } from './a1.ts';
import type { Bridge } from './feishu.ts';
import { feishuDocPath, need } from './util.ts';

/**
 * Reads the requirement document a user links to (a sheet tab or a docx, directly or as a wiki node) into plain text the agent can
 * work from: the title (it usually names the supplier), and the rows of the tab or the text of the doc. Read-only; the content is
 * data, never instructions.
 */

type Obj = Record<string, any>;
const MAX_ROWS = 300;
const MAX_COLS = 60;
const CELL_CHARS = 300;
const DOC_CHARS = 30_000;
const MAX_DEPTH = 8;

/** What a cell shows, as text: rich-text segments joined, an attachment by its file name, an image as [图片]. */
export function cellShown(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(cellShown).join('');
  if (typeof value === 'object') {
    const v = value as Obj;
    if (v.type === 'attachment') return `[附件:${String(v.text ?? '').trim() || '文件'}]`;
    if (v.type === 'embed-image' || v.type === 'image') return '[图片]';
    if (typeof v.text === 'string') return v.text;
    if (typeof v.link === 'string') return v.link;
  }
  return '';
}

const clip = (text: string, limit: number | undefined): [string, boolean] => {
  const chars = [...text];
  return limit !== undefined && chars.length > limit ? [`${chars.slice(0, limit).join('')}…`, true] : [text, false];
};

async function readSheet(bridge: Bridge, token: string, title: string, linked: string | null, wanted: string | undefined, full: boolean): Promise<Obj> {
  const listed = (await bridge.apiRead(`/open-apis/sheets/v3/spreadsheets/${token}/sheets/query`)).sheets;
  need(Array.isArray(listed), '读不到表格的工作表列表');
  const tabs = (listed as Obj[]).filter(s => s.resource_type === 'sheet' && !s.hidden).sort((a, b) => a.index - b.index);
  need(tabs.length > 0, '表格里没有可读的工作表');
  let tab: Obj | undefined;
  let chosenBy: string;
  if (wanted !== undefined) {
    tab = tabs.find(s => s.sheet_id === wanted) ?? tabs.find(s => s.title === wanted);
    need(tab, `表格里没有工作表“${wanted}”`);
    chosenBy = 'asked';
  } else if (linked) {
    tab = tabs.find(s => s.sheet_id === linked);
    need(tab, '链接指向的工作表不存在或已隐藏');
    chosenBy = 'link';
  } else {
    // Requirement sheets add a tab per delivery (2026.10.16, …); without a tab in the link the last one is the newest.
    tab = tabs[tabs.length - 1]!;
    chosenBy = tabs.length === 1 ? 'only' : 'last';
  }
  const rows = Math.min(Number(tab.grid_properties?.row_count) || 1, MAX_ROWS + 1);
  const cols = Math.min(Number(tab.grid_properties?.column_count) || 1, MAX_COLS);
  const data = await bridge.apiRead(`/open-apis/sheets/v2/spreadsheets/${token}/values_batch_get`,
    { ranges: `${tab.sheet_id}!A1:${columnLetter(cols)}${rows}`, dateTimeRenderOption: 'FormattedString' });
  const values: unknown[][] = data?.valueRanges?.[0]?.values ?? [];
  need(Array.isArray(values), '表格内容返回结构不匹配');
  const text = values.map(row => (Array.isArray(row) ? row : []).map(cell => cellShown(cell).trim()));
  const width = Math.max(0, ...text.map(row => row.reduce((w, cell, i) => (cell !== '' ? i + 1 : w), 0)));
  let clipped = 0;
  const shown = (cells: string[]) => Array.from({ length: width }, (_, i) => {
    const [value, cut] = clip(cells[i] ?? '', full ? undefined : CELL_CHARS);
    if (cut) clipped++;
    return value;
  });
  const body = text.slice(1).map((cells, i) => ({ row: i + 2, cells })).filter(r => r.cells.some(cell => cell !== ''));
  return {
    status: 'document', kind: 'sheet', title, sheet: { sheet_id: tab.sheet_id, title: tab.title, chosen_by: chosenBy },
    tabs: tabs.map(s => s.title), columns: Array.from({ length: width }, (_, i) => columnLetter(i + 1)), header: shown(text[0] ?? []),
    rows: body.map(r => ({ row: r.row, cells: shown(r.cells) })), row_count: body.length,
    ...(Number(tab.grid_properties?.row_count) > rows ? { more_rows: true } : {}), ...(clipped ? { clipped_cells: clipped } : {}),
  };
}

/**
 * The folder titles above a wiki node, outermost first (the breadcrumb Feishu shows: a person's or a supplier's folder often says
 * who the document belongs to). Best effort: a parent the user cannot read ends the path, it never fails the read.
 */
async function wikiAncestors(bridge: Bridge, parent: string): Promise<string[]> {
  const titles: string[] = [];
  const seen = new Set<string>();
  for (let next = parent; next && !seen.has(next) && seen.size < MAX_DEPTH;) {
    seen.add(next);
    let node: Obj | undefined;
    try {
      node = (await bridge.apiRead('/open-apis/wiki/v2/spaces/get_node', { token: next, obj_type: 'wiki' })).node;
    } catch {
      break;
    }
    if (!node) break;
    if (typeof node.title === 'string' && node.title.trim()) titles.unshift(node.title.trim());
    next = String(node.parent_node_token ?? '');
  }
  return titles;
}

/**
 * What a document link points at: its kind (sheet or docx, a wiki node resolved to what it holds), the token of that, its wiki node
 * (empty for a direct link), the title the wiki gives it, the wiki parent, and the tab the link names (`?sheet=`).
 */
export async function docTarget(bridge: Bridge, url: string): Promise<{ type: string; token: string; node: string; title: string; parent: string; linked: string | null }> {
  const docPath = feishuDocPath(url, 'docx|wiki|sheets', true);
  need(docPath, '不是公司飞书文档链接（需要 wiki、docx 或 sheets 链接）');
  const [, kind, token] = docPath.replace(/\/$/, '').split('/') as [string, string, string];
  const linked = new URL(url).searchParams.get('sheet');
  if (kind !== 'wiki') return { type: kind === 'sheets' ? 'sheet' : kind, token, node: '', title: '', parent: '', linked };
  const node = (await bridge.apiRead('/open-apis/wiki/v2/spaces/get_node', { token, obj_type: 'wiki' })).node;
  need(node && typeof node.obj_token === 'string', '读不到这个知识库节点');
  return { type: node.obj_type, token: node.obj_token, node: token, title: String(node.title ?? ''), parent: String(node.parent_node_token ?? ''), linked };
}

/** The requirement document behind a link: a sheet tab as header and rows, a docx as its text. */
export async function readBrief(bridge: Bridge, url: string, options: { sheet?: string; full?: boolean } = {}): Promise<Obj> {
  const { type, token: objToken, title: wikiTitle, parent: wikiParent, linked } = await docTarget(bridge, url);
  let title = wikiTitle;
  const result: Obj = { url };
  if (wikiParent) {
    const path = await wikiAncestors(bridge, wikiParent);
    if (path.length) result.path = path;
  }
  if (type === 'sheet') {
    if (!title) title = String((await bridge.apiRead(`/open-apis/sheets/v3/spreadsheets/${objToken}`))?.spreadsheet?.title ?? '');
    return { ...await readSheet(bridge, objToken, title, linked, options.sheet, options.full === true), ...result };
  }
  need(type === 'docx', `暂不支持读取这种飞书文档（${type}），请给表格或新版文档的链接`);
  need(options.sheet === undefined, '--sheet 只用于表格');
  const content = String((await bridge.apiRead(`/open-apis/docx/v1/documents/${objToken}/raw_content`)).content ?? '');
  // A docx's raw text starts with its title.
  if (!title) title = content.split('\n').find(line => line.trim() !== '')?.trim() ?? '';
  const [text, cut] = clip(content, options.full ? undefined : DOC_CHARS);
  return { status: 'document', kind: 'docx', title, text, chars: [...content].length, ...(cut ? { clipped: true } : {}), ...result };
}
