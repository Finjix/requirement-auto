import fs from 'node:fs';
import path from 'node:path';
import { CellRange, columnLetter, coordOf } from './a1.ts';
import { loadBatch } from './batch.ts';
import { checkSeal, seal } from './seal.ts';
import type { Plan } from './plan.ts';
import type { Snapshot } from './snapshot.ts';
import { canonical, checkTarget, isInside, need, readJson, writeJsonNew } from './util.ts';

/** The dropdown rules as the Feishu API reports them, compared the same way the XLSX rules are. */

type Obj = Record<string, any>;
export interface ApiRule { sheet_id: string; ranges: string[]; type: 'list'; options: string[]; multiple: boolean; highlight: boolean; colors: Record<string, string> }

export const PALETTE = ['#bacefd', '#a9efe6', '#e5d6ff', '#fed4a4', '#c4e8a0'];
const ruleBody = (r: ApiRule) => ({ options: r.options, multiple: r.multiple, highlight: r.highlight, colors: r.colors });

/** Union intervals per sheet and column, excluding only the approved append rectangle. */
export function ruleProjection(records: ApiRule[], ownedSheet?: string, ownedRange?: string): unknown[] {
  const buckets = new Map<string, { sheetId: string; col: number; signature: string; intervals: [number, number][] }>();
  const area = ownedRange ? new CellRange(ownedRange) : undefined;
  for (const entry of records) {
    const signature = canonical({ type: entry.type, ...ruleBody(entry) });
    for (const raw of entry.ranges) {
      const rect = new CellRange(raw);
      for (let col = rect.minCol; col <= rect.maxCol; col++) {
        let intervals: [number, number][] = [[rect.minRow, rect.maxRow]];
        if (entry.sheet_id === ownedSheet && area && area.minCol <= col && col <= area.maxCol) {
          intervals = [[rect.minRow, Math.min(rect.maxRow, area.minRow - 1)], [Math.max(rect.minRow, area.maxRow + 1), rect.maxRow]];
        }
        const key = `${entry.sheet_id}\u0000${col}\u0000${signature}`;
        let bucket = buckets.get(key);
        if (!bucket) { bucket = { sheetId: entry.sheet_id, col, signature, intervals: [] }; buckets.set(key, bucket); }
        bucket.intervals.push(...intervals.filter(([lo, hi]) => lo <= hi));
      }
    }
  }
  const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  const result: unknown[] = [];
  for (const b of [...buckets.values()].sort((x, y) => compare(x.sheetId, y.sheetId) || x.col - y.col || compare(x.signature, y.signature))) {
    const merged: [number, number][] = [];
    for (const [lo, hi] of [...b.intervals].sort((p, q) => p[0] - q[0] || p[1] - q[1])) {
      const tail = merged[merged.length - 1];
      if (tail && lo <= tail[1] + 1) tail[1] = Math.max(hi, tail[1]);
      else merged.push([lo, hi]);
    }
    if (merged.length) result.push([b.sheetId, b.col, b.signature, merged]);
  }
  return result;
}

/** The dropdown to write for each planned field: the nearest existing rule's mode and colors, plus the missing options. */
export function dropdowns(plan: Plan, sheetId: string, records: ApiRule[]): Obj[] {
  const result: Obj[] = [];
  const area = new CellRange(plan.range);
  for (const spec of plan.dropdowns as Obj[]) {
    const col = new CellRange(spec.range).minCol;
    const found: [number, ApiRule][] = [];
    for (const rule of records) {
      if (rule.sheet_id !== sheetId) continue;
      for (const raw of rule.ranges) {
        const rect = new CellRange(raw);
        if (rect.minCol <= col && col <= rect.maxCol && rect.minRow < area.minRow) found.push([Math.min(rect.maxRow, area.minRow - 1), rule]);
      }
    }
    need(found.length > 0, `${spec.field} 缺少可保留模式/颜色的原规则`);
    const nearest = Math.max(...found.map(([end]) => end));
    const choices = new Map<string, ApiRule>();
    for (const [end, r] of found) if (end === nearest) choices.set(canonical(ruleBody(r)), r);
    need(choices.size === 1, '最近下拉规则冲突，需要澄清');
    const rule = [...choices.values()][0]!;
    // Only the values this request asks for are added to the rule being kept. The XLSX export is not a reliable source of a column's options
    // (it can attribute a stray rule on a few old cells to the whole column), so spec.options is not used here.
    const wanted = [...new Set((plan.request.groups as Obj[]).map(g => g[spec.field as string] as string).filter(Boolean))];
    const options = [...rule.options, ...wanted.filter(v => !rule.options.includes(v))];
    const colors = options.map((v, i) => rule.colors[v] ?? PALETTE[i % PALETTE.length]!);
    // Existing highlighted options must have an actual color, never a guessed replacement.
    need(!rule.highlight || rule.options.every(v => v in rule.colors), '原下拉配色未完整读取');
    result.push({ field: spec.field, range: spec.range, options, mode: rule.multiple ? 'multiple' : 'single', highlight: rule.highlight,
      colors, missing: options.filter(v => !rule.options.includes(v)) });
  }
  return result;
}

/** One write per non-empty column, every one with allow_overwrite=false. */
export function buildWrites(plan: Plan, context: Obj): Obj[] {
  checkSeal(context, 'api_plan_id');
  need(context.batch_plan_id === plan.plan_id && context.baseline_digest === plan.baseline_digest, '接口计划与批次不匹配');
  checkTarget(context.target);
  const area = new CellRange(plan.range);
  need(area.maxRow - area.minRow + 1 <= 5000, '单批超出官方写入行数上限，请先拆分计划');
  const validation = new Map<number, Obj>((context.dropdowns as Obj[]).map(d => [new CellRange(d.range).minCol, d]));
  const writes: Obj[] = [];
  for (let col = area.minCol; col <= area.maxCol; col++) {
    const letter = columnLetter(col);
    const values = (plan.rows as Obj[]).map(row => row.values[`${letter}${row.row}`] as string | number | null);
    if (values.every(v => v === null)) continue; // Never send nulls/clears into unused fields.
    need(values.every(v => v !== null), '写入列有空洞，不允许混合清空操作');
    const cells = values.map(value => {
      const cell: Obj = typeof value === 'string' && value.startsWith('=') ? { formula: value } : { value };
      const d = validation.get(col);
      if (d) {
        cell.data_validation = { type: 'list', items: d.options, support_multiple_values: d.mode === 'multiple',
          enable_highlight: d.highlight, highlight_colors: d.colors };
        if (d.mode === 'multiple') { delete cell.value; cell.multiple_values = [{ value }]; }
      }
      return [cell];
    });
    writes.push({ sheet_id: context.sheet_id, range: `${letter}${area.minRow}:${letter}${area.maxRow}`, cells, allow_overwrite: false });
  }
  need(writes.length > 0 && writes.length <= 100, '追加写入范围数不支持');
  need(writes.reduce((n, w) => n + w.cells.length, 0) <= 50000, '单批超过单元格预算，请先拆分计划');
  return writes;
}

function checkNewRules(records: ApiRule[], sheetId: string, dropdownSpecs: Obj[], verifiedAgainst: 'proof' | 'fresh'): void {
  for (const spec of dropdownSpecs) {
    const rect = new CellRange(spec.range);
    for (let row = rect.minRow; row <= rect.maxRow; row++) {
      const coord = coordOf(rect.minCol, row);
      const matching = records.filter(r => r.sheet_id === sheetId && r.ranges.some(a => new CellRange(a).contains(coord)));
      if (verifiedAgainst === 'fresh') need(new Set(matching.map(r => canonical(ruleBody(r)))).size === 1, '新增下拉规则缺失/冲突');
      else need(matching.length > 0, '新增规则验收失败');
      const same = (r: ApiRule) => canonical(r.options) === canonical(spec.options) && r.multiple === (spec.mode === 'multiple')
        && r.highlight === spec.highlight && (!spec.highlight || canonical(r.options.map(v => r.colors[v])) === canonical(spec.colors));
      if (verifiedAgainst === 'fresh') need(same(matching[0]!), '新增下拉选项/颜色/模式不匹配');
      else need(matching.every(same), '新增规则验收失败');
    }
  }
}

/** After a write: the old rules must be unchanged and the new rows must carry the planned dropdowns. Writes the proof file. */
export function ruleProof(file: string, fresh: Snapshot, records: ApiRule[], context: Obj, plan: Plan): Obj {
  const sid = context.sheet_id as string;
  need(canonical(ruleProjection(context.rules, sid, plan.range)) === canonical(ruleProjection(records, sid, plan.range)),
    'API 检测到历史下拉规则/颜色/模式变化');
  checkNewRules(records, sid, context.dropdowns, 'fresh');
  const proof = seal({ transport: 'feishu_api', api_plan_id: context.api_plan_id, snapshot_digest: fresh.fingerprint, rules: records }, 'proof_id');
  writeJsonNew(file, proof);
  return proof;
}

/** Called by verify: recomputes the proof from the saved rules instead of trusting a success flag. */
export function validateRuleEvidence(dir: string, fresh: Snapshot, evidence: Obj): Obj[] {
  const { path: batchPath, manifest } = loadBatch(dir);
  need('api-plan.json' in manifest.artifacts, '缺少不可变接口计划');
  const context = readJson(path.join(batchPath, 'api-plan.json'));
  checkSeal(context, 'api_plan_id');
  need(evidence && typeof evidence === 'object' && evidence.transport === 'feishu_api', '接口批次需要 API 规则验收证据');
  const proofPath = path.resolve(String(evidence.proof ?? ''));
  need(isInside(batchPath, proofPath) && fileExists(proofPath), '规则验收记录不在本批目录内');
  const proof = readJson(proofPath);
  checkSeal(proof, 'proof_id');
  need(proof.api_plan_id === context.api_plan_id && proof.snapshot_digest === fresh.fingerprint, '规则证据与接口计划/当前 XLSX 不匹配');
  // Recompute all comparisons without writing another proof.
  const plan = manifest.plan as Plan;
  const sid = context.sheet_id as string;
  need(canonical(ruleProjection(context.rules, sid, plan.range)) === canonical(ruleProjection(proof.rules, sid, plan.range)), '历史下拉规则发生变化');
  checkNewRules(proof.rules, sid, context.dropdowns, 'proof');
  return context.dropdowns;
}

function fileExists(file: string): boolean {
  try { return fs.statSync(file).isFile(); } catch { return false; }
}

/** The write-protection receipt the isolated probe leaves behind; production appends are refused without it. */
export function acceptance(receipt: string, bridgeVersion: string): Obj {
  const data = readJson(receipt);
  checkSeal(data, 'receipt_id');
  need(data.bridge_version === bridgeVersion && data.identity === 'user' && data.schema === 2 && data.probe_workbook
    && canonical(data.passed) === canonical(['occupied_value', 'empty_formula', 'repeated_occupancy']),
  '飞书防覆盖行为尚未通过隔离实测，禁止接口追加');
  need(data.probe_workbook !== data.production_token, '安全探测不能使用进度表');
  const expected = [['KEEP_EXISTING', '=IF(1=1,"","")']];
  const observations: Obj[] = data.observations ?? [];
  need(observations.length === 3 && canonical(observations.map(o => o.case)) === canonical(data.passed)
    && observations.every(o => o.rejection === 'non_empty' && canonical(o.before) === canonical(expected) && canonical(o.after) === canonical(expected)),
  '安全记录缺少每次拒写及原值/公式回读');
  return data;
}
