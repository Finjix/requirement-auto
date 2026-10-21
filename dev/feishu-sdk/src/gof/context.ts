import { Bridge, OPTION_FIELDS, readRules, sheetsOf, target } from './feishu.ts';
import { columnOptions } from './rules.ts';
import { chooseSheet, collectIds, type Snapshot } from './snapshot.ts';
import { canonical, need } from './util.ts';

/**
 * What the agent needs besides the requirement document to fill a request in by itself: the target sheet, the next material number and
 * the dropdown options. Never earlier rows or earlier batches: the agent works from the document alone. Read-only.
 */

type Obj = Record<string, any>;

export interface ContextOptions { worksheet?: string | undefined }

export async function context(bridge: Bridge, snapshot: Snapshot, options: ContextOptions = {}): Promise<Obj> {
  await bridge.doctor();
  const [sheet, tables] = chooseSheet(snapshot, options.worksheet ? { worksheet: options.worksheet } : {}, null);
  const cols = tables[sheet]!;
  const token = await target(bridge);
  const metadata = await sheetsOf(bridge, token);
  need(canonical([...metadata].sort((a, b) => a.index - b.index).map(s => s.title)) === canonical(snapshot.sheetNames), 'API 工作表列表与 XLSX 不匹配，先重新导出快照');
  const meta = metadata.find(s => s.title === sheet)!;
  const rules = await readRules(bridge, token, [meta]);
  const last = snapshot.last[sheet]!;
  const optionsOf = Object.fromEntries(Object.values(OPTION_FIELDS).map(field => [field, field in cols ? columnOptions(rules, meta.sheet_id, cols[field]!, last) : []]));
  const next = [...collectIds(snapshot, tables).keys()].reduce((a, b) => Math.max(a, b), 0) + 1;
  return {
    status: 'context', worksheet: sheet, sheet_id: meta.sheet_id, next_number: next, options: optionsOf,
  };
}
