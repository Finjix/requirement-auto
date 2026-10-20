import fs from 'node:fs';
import path from 'node:path';
import { defaultBatchRoot, events, loadBatch } from './batch.ts';
import { requirementName } from './cls.ts';
import { Bridge, OPTION_FIELDS, readRules, sheetsOf, target } from './feishu.ts';
import { itemsOf } from './request.ts';
import { columnOptions } from './rules.ts';
import { chooseSheet, collectIds, scanSheets, sheetPeriod, type Snapshot } from './snapshot.ts';
import { canonical, need } from './util.ts';

/**
 * What the agent needs besides the requirement document to fill a request in by itself: the dropdown options of the target sheet, how
 * the latest rows were filled (per supplier), and what this user's earlier batches asked for (their CLS choices). Read-only.
 */

type Obj = Record<string, any>;
const RUN_FIELDS = ['supplier', 'primary_tag', 'secondary_tag', 'creative_form', 'creator'];

/**
 * The latest runs of rows in the GOFCN progress sheets, newest first. Consecutive rows filled the same way (supplier, tags, form,
 * reviewer) are one run, the way one request was appended; rows with none of these filled are passed over. With `supplier`, only
 * that supplier's runs.
 */
export function recentRuns(snapshot: Snapshot, options: { supplier?: string | undefined; limit?: number } = {}): Obj[] {
  const { tables } = scanSheets(snapshot);
  const period = (name: string) => { const p = sheetPeriod(name); return p ? p[0] * 100 + p[1] : -1; };
  const limit = options.limit ?? 12;
  const runs: Obj[] = [];
  for (const sheet of Object.keys(tables).sort((a, b) => period(b) - period(a))) {
    const cols = tables[sheet]!;
    const text = (row: number, field: string) => String(snapshot.cell(sheet, row, cols[field]!)?.value ?? '').trim();
    let run: Obj | undefined;
    const close = () => {
      if (run && (options.supplier === undefined || run.values.supplier === options.supplier)) {
        const numbers = run.numbers as number[];
        runs.push({
          sheet, rows: `${run.rows.at(-1)}-${run.rows[0]}`, count: run.rows.length,
          numbers: numbers.length ? `GOFCN${Math.min(...numbers)}-GOFCN${Math.max(...numbers)}` : null, ...run.values,
          keywords: run.keywords.slice(0, 3), ...(run.keywords.length > 3 ? { other_keywords: run.keywords.length - 3 } : {}),
        });
      }
      run = undefined;
    };
    for (let r = snapshot.last[sheet]!; r >= 2 && runs.length < limit; r--) {
      const values = Object.fromEntries(RUN_FIELDS.map(f => [f, text(r, f)]));
      if (RUN_FIELDS.every(f => values[f] === '')) continue;
      const key = canonical(values);
      if (run?.key !== key) {
        close();
        if (runs.length >= limit) break;
        run = { key, values, rows: [], numbers: [], keywords: [] };
      }
      run!.rows.push(r);
      const number = text(r, 'number');
      if (/^\d+$/.test(number)) run!.numbers.push(Number(number));
      const keyword = text(r, 'keyword');
      if (keyword && !run!.keywords.includes(keyword)) run!.keywords.push(keyword);
    }
    close();
    if (runs.length >= limit) break;
  }
  return runs.slice(0, limit);
}

/** This user's earlier batches, newest first: what each asked for and how far it got. Batches that do not check out are left out. */
export function pastRequests(root: string, options: { supplier?: string | undefined; limit?: number } = {}): Obj[] {
  let names: string[];
  try { names = fs.readdirSync(root); } catch { return []; }
  const found: Obj[] = [];
  for (const name of names) {
    const dir = path.join(root, name);
    try {
      const { manifest } = loadBatch(dir);
      const records = events(dir);
      const plan = manifest.plan;
      const groups = (plan.groups as Obj[]).map(g => ({
        supplier: g.request.supplier, reviewer: g.request.reviewer, script_url: g.request.script_url, cls: g.request.cls,
        requirement_name: requirementName(g.names), quantity: g.request.quantity,
        items: itemsOf(g.request).map(item => ({ quantity: item.quantity, primary_tag: item.primary_tag, secondary_tag: item.secondary_tag,
          creative_form: item.creative_form, keyword: item.keyword })),
        steps: records.filter(e => e.group === g.id).map(e => e.step),
      }));
      if (options.supplier !== undefined && !groups.some(g => g.supplier === options.supplier)) continue;
      found.push({ prepared_at: fs.statSync(path.join(dir, 'manifest.json')).mtime.toISOString(), worksheet: plan.worksheet,
        numbers: `GOFCN${plan.first_number}-GOFCN${plan.last_number}`, append_verified: records.some(e => e.step === 'append_verified'), groups });
    } catch { /* not a batch, or one that no longer checks out */ }
  }
  return found.sort((a, b) => (a.prepared_at < b.prepared_at ? 1 : -1)).slice(0, options.limit ?? 8);
}

export interface ContextOptions { worksheet?: string | undefined; supplier?: string | undefined; batchRoot?: string | undefined }

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
    recent: recentRuns(snapshot, { supplier: options.supplier }),
    past_requests: pastRequests(options.batchRoot ?? defaultBatchRoot(), { supplier: options.supplier }),
  };
}
