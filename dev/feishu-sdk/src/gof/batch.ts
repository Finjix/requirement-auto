import fs from 'node:fs';
import path from 'node:path';
import { CellRange, columnLetter, coordOf } from './a1.ts';
import { makePlan, type Plan } from './plan.ts';
import { itemsOf } from './request.ts';
import { resolveDataPaths } from '../paths.ts';
import { checkSeal, rejectSecrets } from './seal.ts';
import { hasContent, inlineOptions, plainRules, Snapshot, validationProjection, holds } from './snapshot.ts';
import { validateBatchReceipt, validateReceipt } from './cls.ts';
import { validateRuleEvidence } from './rules.ts';
import {
  Blocked, canonical, checkClsUrl, isInside, checkTarget, CSV_HEADERS, digest, FIXED_TAG, need, readJson, sha256, TARGET, writeJsonNew,
} from './util.ts';

const BOM = String.fromCharCode(0xfeff);

export type Evidence = Record<string, any>;
export interface BatchEvent { step: string; group: string | null; evidence: Evidence; time: string; previous: string; event_id: string }

/** Where batches go unless told otherwise: the served user's own directory (see paths.ts). */
export function defaultBatchRoot(): string {
  try { return resolveDataPaths().batches; } catch (error) { throw new Blocked((error as Error).message); }
}

export function loadBatch(dir: string): { path: string; manifest: Record<string, any> } {
  const batchPath = path.resolve(dir);
  const manifest = readJson(path.join(batchPath, 'manifest.json'));
  const plan = manifest.plan as Plan;
  const { plan_id: token, ...unsealed } = plan;
  need(digest(unsealed).slice(0, 24) === token && path.basename(batchPath) === token, '批次清单损坏或目录与计划不匹配');
  need(manifest.baseline_sha256 === sha256(fs.readFileSync(path.join(batchPath, 'baseline.xlsx'))), '基线文件发生变化');
  for (const [name, expected] of Object.entries<string>(manifest.artifacts)) {
    need(path.basename(name) === name && sha256(fs.readFileSync(path.join(batchPath, name))) === expected, `批次文件发生变化：${name}`);
  }
  return { path: batchPath, manifest };
}

function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

export function clipboardTsv(plan: Plan): string {
  const area = new CellRange(plan.range);
  const lines: string[] = [];
  for (const row of plan.rows) {
    const cells: string[] = [];
    for (let col = area.minCol; col <= area.maxCol; col++) {
      const raw = row.values[coordOf(col, row.row)];
      const value = raw === null || raw === undefined ? '' : String(raw);
      need(!/[\t\r\n]/.test(value), '剪贴板单元格包含分隔符，不能生成原始 TSV');
      cells.push(value);
    }
    lines.push(cells.join('\t'));
  }
  return `${lines.join('\r\n')}\r\n`;
}

export interface PrepareOptions { workspace?: string | undefined; apiPlan?: Record<string, any> | undefined; outputRoot?: string | undefined }

export function prepare(plan: Plan, snapshot: Snapshot, options: PrepareOptions = {}): Record<string, any> {
  need(canonical(plan) === canonical(makePlan(snapshot, plan.request, plan.current_sheet)), '当前快照与获批计划不同，需更新计划并重新确认');
  const { apiPlan, workspace, outputRoot } = options;
  if (apiPlan) {
    checkSeal(apiPlan, 'api_plan_id');
    checkTarget(apiPlan.target ?? '');
    need(apiPlan.batch_plan_id === plan.plan_id && apiPlan.baseline_digest === snapshot.fingerprint, '接口计划与本批快照不匹配');
  }
  const tsv = clipboardTsv(plan);
  need(!(workspace !== undefined && outputRoot !== undefined), '--workspace 与 --output-root 不能同时使用');
  const base = outputRoot !== undefined ? path.resolve(outputRoot)
    : workspace !== undefined ? path.join(path.resolve(workspace), 'outputs', 'gof-requirement') : defaultBatchRoot();
  fs.mkdirSync(base, { recursive: true });
  const dir = path.join(base, plan.plan_id);
  fs.mkdirSync(dir);
  try {
  // No in-place rewrite or rollback of a partially generated batch.
  fs.copyFileSync(snapshot.path, path.join(dir, 'baseline.xlsx'), fs.constants.COPYFILE_EXCL);
  // Browser clipboard TSV is not CSV: quoting formulas makes them literal text.
  fs.writeFileSync(path.join(dir, 'append.tsv'), tsv, { encoding: 'utf8', flag: 'wx' });
  for (const group of plan.groups) {
    const lines = [CSV_HEADERS.map(csvField).join(',')];
    group.names.forEach((name: string, index: number) => {
      lines.push([name, index === 0 ? group.request.script_url : '同上', FIXED_TAG].map(csvField).join(','));
    });
    fs.writeFileSync(path.join(dir, group.csv), `${BOM}${lines.join('\r\n')}\r\n`, { encoding: 'utf8', flag: 'wx' });
  }
  const files = ['append.tsv', ...plan.groups.map((g: Plan) => g.csv)];
  if (apiPlan) {
    writeJsonNew(path.join(dir, 'api-plan.json'), apiPlan);
    files.push('api-plan.json');
  }
  const artifacts: Record<string, string> = {};
  for (const name of files) artifacts[name] = sha256(fs.readFileSync(path.join(dir, name)));
  writeJsonNew(path.join(dir, 'manifest.json'), { plan, baseline_sha256: sha256(fs.readFileSync(path.join(dir, 'baseline.xlsx'))), artifacts });
  fs.mkdirSync(path.join(dir, 'events'));
  return { status: 'prepared', batch: dir, range: plan.range, csv: plan.groups.map((g: Plan) => g.csv) };
  } catch (error) {
    // This call made the directory a moment ago and nothing has been recorded in it: a half-made batch would block the plan for good.
    fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

export function events(dir: string): BatchEvent[] {
  const folder = path.join(dir, 'events');
  const files = fs.readdirSync(folder).filter(f => f.endsWith('.json')).sort();
  const records: BatchEvent[] = [];
  let previous = '';
  files.forEach((file, offset) => {
    need(file === `${String(offset + 1).padStart(6, '0')}.json`, '批次事件缺失/排序异常');
    const { event_id: token, ...event } = readJson(path.join(folder, file));
    need(event.previous === previous, '批次事件链损坏');
    need(digest(event) === token, '批次事件被修改');
    records.push({ ...event, event_id: token } as BatchEvent);
    previous = token;
  });
  return records;
}

export function status(dir: string): Record<string, any> {
  const { path: batchPath, manifest } = loadBatch(dir);
  const records = events(batchPath);
  let blocked = false;
  for (const event of records) if (event.step === 'blocked' || event.step === 'resumed') blocked = event.step === 'blocked';
  const groups: Record<string, string[]> = {};
  for (const g of manifest.plan.groups) groups[g.id] = records.filter(e => e.group === g.id).map(e => e.step);
  return { status: 'recorded', plan_id: manifest.plan.plan_id, events: records,
    append_verified: records.some(e => e.step === 'append_verified'), blocked, groups };
}

function filterExtendsOnlyIntoAppend(before: Record<string, any> | null, after: Record<string, any> | null, area: CellRange): boolean {
  if (!before?.ref || !after?.ref) return false;
  let oldRange: CellRange;
  let newRange: CellRange;
  try { oldRange = new CellRange(before.ref); newRange = new CellRange(after.ref); } catch { return false; }
  return oldRange.minCol === newRange.minCol && oldRange.maxCol === newRange.maxCol && oldRange.minRow === newRange.minRow
    && oldRange.maxRow < newRange.maxRow && oldRange.maxRow + 1 >= area.minRow && newRange.maxRow === area.maxRow
    && before.rest === after.rest;
}

function uiValidatesOmittedDropdown(spec: Plan, evidence: unknown, fresh: Snapshot, sheet: string, value: string | null): boolean {
  if (!Array.isArray(evidence)) return false;
  const matches = evidence.filter(item => item && typeof item === 'object' && !Array.isArray(item)
    && item.worksheet === sheet && item.range === spec.range);
  if (matches.length !== 1) return false;
  const item = matches[0];
  const options = item.options;
  if (!(item.confirmed === true && item.saved === true && item.source === 'custom' && item.reason === 'xlsx_omits_inline_rule'
    && item.snapshot_digest === fresh.fingerprint && (item.mode === 'single' || item.mode === 'multiple')
    && Array.isArray(options) && options.every(o => typeof o === 'string' && o !== '')
    && value !== null && options.includes(value) && spec.options.every((o: string) => options.includes(o)))) return false;
  try {
    checkTarget(item.url ?? '');
    const screenshot = String(item.screenshot ?? '');
    return path.isAbsolute(screenshot) && fs.statSync(screenshot).isFile();
  } catch { return false; }
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const ROW_COL = (coord: string) => { const m = /^([A-Z]+)(\d+)$/.exec(coord)!; return [Number(m[2]), m[1]!.length, m[1]!] as const; };
function byPosition(a: string, b: string): number {
  const [ra, la, ca] = ROW_COL(a);
  const [rb, lb, cb] = ROW_COL(b);
  return ra - rb || la - lb || (ca < cb ? -1 : ca > cb ? 1 : 0);
}

export function verify(dir: string, fresh: Snapshot, validationEvidence?: unknown): Record<string, any> {
  const { path: batchPath, manifest } = loadBatch(dir);
  const plan = manifest.plan as Plan;
  let apiDropdowns: Plan[] | null = null;
  const evidenceIsApi = validationEvidence !== null && typeof validationEvidence === 'object' && !Array.isArray(validationEvidence)
    && (validationEvidence as Evidence).transport === 'feishu_api';
  // API rules are checked even when the XLSX happens to include validations.
  // A pre-write or zero-applied snapshot can still be inspected without post-write proof.
  if ('api-plan.json' in manifest.artifacts && evidenceIsApi) apiDropdowns = validateRuleEvidence(batchPath, fresh, validationEvidence as Evidence);
  const baseline = new Snapshot(path.join(batchPath, 'baseline.xlsx'));
  try {
    need(baseline.fingerprint === plan.baseline_digest, '基线语义摘要与计划不一致');
    const sheet = plan.worksheet as string;
    const area = new CellRange(plan.range);
    const issues: string[] = [];
    if (canonical(fresh.sheetNames) !== canonical(baseline.sheetNames)) issues.push('工作表列表/顺序发生变化');
    const expected: Record<string, string | number | null> = {};
    for (const row of plan.rows) Object.assign(expected, row.values);
    const owned = (name: string, coord: string) => name === sheet && area.contains(coord);
    const sheetNames = [...new Set([...Object.keys(baseline.cells), ...Object.keys(fresh.cells)])];
    scan: for (const name of sheetNames) {
      const before = baseline.cells[name] ?? {};
      const after = fresh.cells[name] ?? {};
      for (const coord of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort(byPosition)) {
        if (!owned(name, coord) && canonical(before[coord]) !== canonical(after[coord])) {
          issues.push(`计划外修改：${name}!${coord}`);
          if (issues.length >= 20) break scan;
        }
      }
    }
    const beforeMeta = clone(baseline.meta) as Record<string, any>;
    const afterMeta = clone(fresh.meta) as Record<string, any>;
    for (const data of [beforeMeta, afterMeta]) {
      if (data[sheet]) {
        data[sheet].rows = Object.fromEntries(Object.entries<unknown[]>(data[sheet].rows)
          .filter(([r]) => !(area.minRow <= Number(r) && Number(r) <= area.maxRow)));
      }
    }
    if (beforeMeta[sheet] && afterMeta[sheet] && filterExtendsOnlyIntoAppend(beforeMeta[sheet].filter, afterMeta[sheet].filter, area)) {
      afterMeta[sheet].filter = beforeMeta[sheet].filter;
    }
    if (canonical(beforeMeta) !== canonical(afterMeta)) issues.push('历史布局/合并/隐藏/保护/筛选发生变化');
    if (canonical(validationProjection(baseline, [sheet, area])) !== canonical(validationProjection(fresh, [sheet, area]))) {
      issues.push('追加范围外的下拉验证发生变化');
    }
    need(fresh.sheetNames.includes(sheet), '目标工作表已不存在');
    const ws = fresh.sheet(sheet);
    let matches = 0;
    let blanks = 0;
    let meaningful = 0;
    for (const [coord, value] of Object.entries(expected)) {
      const actual = ws.cells.get(coord);
      const present = actual !== undefined && actual.value !== null;
      if (value !== null) {
        meaningful++;
        if (holds(actual, value)) matches++;
        else if (!present) blanks++;
        else issues.push(`追加值不符：${coord}`);
      } else if (present) issues.push(`应为空的新增字段被占用：${coord}`);
    }
    let state = issues.length ? 'conflict' : matches === 0 ? 'not_applied' : blanks ? 'partial' : 'complete';
    const uiValidated: string[] = [];
    if (state === 'complete') {
      need(!('api-plan.json' in manifest.artifacts) || apiDropdowns !== null, '接口追加需要当前快照对应的完整 API 规则回读');
      const rules = plainRules(ws);
      for (const dropdown of plan.dropdowns as Plan[]) {
        const r = new CellRange(dropdown.range);
        for (let row = r.minRow; row <= r.maxRow; row++) {
          const coord = `${columnLetter(r.minCol)}${row}`;
          const value = ws.cells.get(coord)?.value ?? null;
          const matching = rules.filter(v => v.ranges.some(range => range.contains(coord)));
          if (apiDropdowns !== null && matching.length === 0) {
            const spec = apiDropdowns.find(d => d.range === dropdown.range);
            if (spec && value !== null && spec.options.includes(value)) continue;
          }
          if (matching.length === 0 && uiValidatesOmittedDropdown(dropdown, validationEvidence, fresh, sheet, value)) {
            if (!uiValidated.includes(dropdown.range)) uiValidated.push(dropdown.range);
            continue;
          }
          if (matching.length === 0 || !matching.some(v => {
            const options = inlineOptions(v);
            return value !== null && options.includes(value) && (dropdown.options as string[]).every(o => options.includes(o));
          })) {
            issues.push(`新增下拉未包含实际值/原有选项：${coord}`);
            break;
          }
        }
      }
      if (issues.length) state = 'conflict';
    }
    const result: Record<string, any> = { status: state, matched_cells: matches, expected_cells: meaningful, issues: issues.slice(0, 20) };
    if (uiValidated.length) result.ui_validated_ranges = uiValidated;
    if (apiDropdowns !== null) result.api_validated_ranges = apiDropdowns.map(d => d.range);
    return result;
  } finally {
    baseline.close();
  }
}

export function canStartAppend(records: BatchEvent[]): boolean {
  if (records.every(e => e.step === 'blocked' || e.step === 'resumed')) return true;
  // A user-authorized retry is consumed by the next append_started event.
  const last = records[records.length - 1];
  return records.length > 0 && last!.step === 'resumed' && last!.evidence.retry_append === true && last!.evidence.sync_confirmed === true
    && records.every(e => ['append_started', 'blocked', 'resumed'].includes(e.step));
}

export function preflight(dir: string, fresh: Snapshot): Record<string, any> {
  const { path: batchPath, manifest } = loadBatch(dir);
  const records = events(batchPath);
  need(!status(batchPath).blocked && canStartAppend(records), '本批已有执行尝试/阻塞，必须先核对现状，不能自动重贴');
  need(fresh.fingerprint === manifest.plan.baseline_digest, '快照变化或目标被占用，需更新计划并确认');
  const area = new CellRange(manifest.plan.range);
  const ws = fresh.sheet(manifest.plan.worksheet);
  for (const cell of ws.cells.values()) {
    if (cell.row >= area.minRow && cell.row <= area.maxRow) need(!hasContent(cell), '目标行已有值、公式或附件元数据');
  }
  return { status: 'ready_to_append', range: area.toString() };
}

export function groupFor(plan: Plan, groupId: string | null): Plan {
  const found = plan.groups.filter((g: Plan) => g.id === groupId);
  need(found.length === 1, '分组编号不存在');
  return found[0];
}

export function clsCheck(dir: string, groupId: string, action: string, ui: Evidence): Record<string, any> {
  need(['fill', 'save_draft', 'import_scripts'].includes(action), '发布/删除/更新脚本及未知动作均不允许');
  const state = status(dir);
  need(state.append_verified && !state.blocked, '进度表尚未验证或批次已阻塞');
  need(groupId in state.groups, '组不存在');
  const stages: string[] = state.groups[groupId];
  const attempted = (state.events as BatchEvent[]).filter(e => e.group === groupId && e.step === 'cls_api_attempt' && e.evidence.action === action);
  need(attempted.length === 0, '本组接口动作已有尝试；必须回读核对，不能自动重发');
  need(stages.includes('cls_started') && !stages.includes('handoff'), '需先记录 CLS 尝试，已移交的组不可自动继续');
  need(ui.logged_in === true, 'CLS 未登录');
  need(ui.can_create === true, '未证明 CLS 有建单权限');
  need(ui.unpublished === true, '未证明当前是未发布的新需求/草稿');
  need(!['failure', 'unknown'].includes(ui.save_result), '草稿保存失败/结果未知，先核对现状');
  if (action === 'save_draft') {
    need(!stages.includes('draft_saved'), '已有草稿，不能按新工单重复保存');
    need(ui.required_complete === true, 'CLS 必填未齐全');
  }
  if (action === 'import_scripts') {
    need(stages.includes('draft_saved') && !stages.includes('scripts_imported'), '未保存草稿或本组已导入，不能重复');
    need(ui.draft_saved === true && ui.unpublished === true, '需确认当前未发布草稿');
    need(ui.import_enabled === true && ui.import_would_publish === false, '脚本导入禁用/需要发布/后果未知，保留内部记录并说明具体阻碍');
  }
  return { status: 'allowed', action, group: groupId };
}

function clsEvidence(evidence: Evidence, apiBatch: boolean): void {
  need(evidence.confirmed === true && evidence.unpublished === true, '没有确认成功及未发布状态');
  checkClsUrl(evidence.url ?? '');
  // A batch made through the bridge (it has an api-plan) only accepts receipts of the CLS API: a screenshot path proves nothing about CLS.
  need(!apiBatch || evidence.transport === 'cls_api', '接口批次的 CLS 证据必须是 transport=cls_api 的接口记录');
  if (evidence.transport === 'cls_api') validateReceipt(evidence);
  else {
    // Historical UI receipts retain their original evidence requirements.
    const screenshot = String(evidence.screenshot ?? '');
    need(path.isAbsolute(screenshot) && fs.existsSync(screenshot) && fs.statSync(screenshot).isFile(), '需已存在的截图绝对路径');
  }
}

const hasReason = (evidence: Evidence) => typeof evidence.reason === 'string' && evidence.reason.trim() !== '';

export function record(dir: string, step: string, groupId?: string | null, evidenceInput?: Evidence | null, fresh?: Snapshot): Record<string, any> {
  const { path: batchPath, manifest } = loadBatch(dir);
  const records = events(batchPath);
  let evidence: Evidence = evidenceInput ?? {};
  rejectSecrets(evidence);
  const state = status(batchPath);
  const group = groupId ?? null;
  need(!state.blocked || step === 'resumed', '已阻塞批次不能继续自动化；保留现场等待用户处理');
  if (step === 'resumed') {
    need(state.blocked && fresh !== undefined && group === null, '恢复需阻塞记录及最新快照');
    need(evidence.confirmed === true && hasReason(evidence), '恢复需用户明确决定及原因');
    const result = verify(batchPath, fresh, evidence.validations);
    const neverAttempted = !records.some(e => e.step === 'append_started');
    if (evidence.retry_append === true) {
      need(!('api-plan.json' in manifest.artifacts), '接口批次已尝试写入后只能回读，不授权重发');
      need(evidence.sync_confirmed === true && !state.append_verified
        && records.every(e => ['append_started', 'blocked', 'resumed'].includes(e.step)), '重试需确认同步完成，且不能已验证追加或开始 CLS');
      need(result.status === 'not_applied' && fresh.fingerprint === manifest.plan.baseline_digest,
        '重试仅允许全批为空且完整快照与基线一致；部分写入/冲突不能重试');
    } else {
      need(result.status === 'complete' || (neverAttempted && result.status === 'not_applied' && fresh.fingerprint === manifest.plan.baseline_digest),
        '部分写入/冲突/未确认的写入尝试不能恢复');
    }
    if (records.some(e => e.step === 'cls_started')) need(evidence.cls_reconciled === true, '需先核对现有草稿/导入结果，避免重复工单');
    evidence = { ...evidence, verified_snapshot_digest: fresh.fingerprint };
  } else if (step === 'append_started') {
    need(canStartAppend(records) && group === null, '已有写入尝试，禁止重复记录/自动重贴');
  } else if (step === 'append_verified') {
    need(group === null, '追加验证不属于某个组');
    need(records.some(e => e.step === 'append_started') && !state.append_verified, '追加验证顺序不正确');
    need(fresh !== undefined && verify(batchPath, fresh, evidence.validations).status === 'complete', '追加未完整通过校验');
  } else if (step === 'blocked') {
    need(hasReason(evidence), '需阻塞原因');
  } else {
    need(state.append_verified, '进度表必须先验证');
    const planGroup = groupFor(manifest.plan, group);
    const stages: string[] = state.groups[group as string];
    need(!stages.includes('handoff') || step === 'requirement_number', '本组已移交，不自动继续');
    if (step === 'cls_started') {
      need(stages.length === 0, '已有 CLS 尝试，先查草稿，不能重复新建');
    } else if (step === 'cls_api_attempt') {
      const action = evidence.action;
      need(['save_draft', 'import_scripts'].includes(action) && typeof evidence.operation_id === 'string'
        && /^[0-9a-f]{64}$/.test(evidence.operation_id), '接口尝试动作/摘要无效');
      clsCheck(batchPath, group as string, action, evidence.observations ?? {});
    } else if (step === 'draft_saved') {
      need(JSON.stringify(stages.filter(s => s !== 'cls_api_attempt')) === JSON.stringify(['cls_started']), '已有草稿或记录顺序错误');
      clsEvidence(evidence, 'api-plan.json' in manifest.artifacts);
      if (evidence.transport === 'cls_api') validateBatchReceipt(batchPath, group as string, evidence, 'draft_saved');
    } else if (step === 'scripts_imported') {
      need(stages.includes('draft_saved') && !stages.includes('scripts_imported'), '导入顺序不正确或重复');
      clsEvidence(evidence, 'api-plan.json' in manifest.artifacts);
      if (evidence.transport === 'cls_api') validateBatchReceipt(batchPath, group as string, evidence, 'scripts_imported');
      need(Number.isInteger(evidence.quantity) && evidence.quantity === planGroup.request.quantity
        && canonical(evidence.names) === canonical(planGroup.names), '导入数量/名称不符');
    } else if (step === 'handoff') {
      need(hasReason(evidence), '需明确人工接手事项');
    } else if (step === 'requirement_number') {
      need(stages.includes('draft_saved') || stages.includes('handoff'), '尚无可补充编号的工单');
      need(evidence.confirmed === true, '正式编号必须来自用户/实际页面或接口回读');
    } else throw new Blocked('事件步骤不受支持');
  }
  const number = evidence.requirement_number;
  if (number !== undefined && number !== null) {
    need(typeof number === 'string' && /^GOFCN\d{11}$/.test(number), '不是正式需求编号；不能使用素材编号/草稿 ID');
  }
  if (step === 'requirement_number') need(number !== undefined && number !== null, '缺少实际需求编号');
  const event: Record<string, any> = {
    step, group, evidence, time: new Date().toISOString(), previous: records.length ? records[records.length - 1]!.event_id : '',
  };
  event.event_id = digest(event);
  writeJsonNew(path.join(batchPath, 'events', `${String(records.length + 1).padStart(6, '0')}.json`), event);
  return { status: 'recorded', step, group };
}

export function message(dir: string): Record<string, any> {
  const { path: batchPath, manifest } = loadBatch(dir);
  const records = events(batchPath);
  const lines = ['请在正式发布后核对并补齐需求编号，再复制到无尽冬日-素材外包结算群发送。', '', '@cici cici老师好，本批需求如下：'];
  for (const group of manifest.plan.groups as Plan[]) {
    const found = [...records].reverse().find(e => e.group === group.id && e.evidence.requirement_number);
    const number = found ? found.evidence.requirement_number : '【发布后补填需求编号】';
    const g = group.request;
    // Rows of the same name body count together, in the order they first appear.
    const kinds = new Map<string, number>();
    for (const item of itemsOf(g)) {
      const kind = `${item.topic} · ${item.creative_form}`;
      kinds.set(kind, (kinds.get(kind) ?? 0) + item.quantity);
    }
    const what = [...kinds].map(([kind, quantity]) => `${kind} * ${quantity}`).join('，');
    lines.push(`需求编号：${number}（${what}）`, `供应商：${g.supplier}`, `创意人：${g.creator}`, '');
  }
  lines.push('辛苦安排一下~');
  return { status: 'message_ready', message: lines.join('\n') };
}

/** The progress sheet's tab of `sheetId` (the sheet itself without one). */
export function sheetUrl(sheetId?: string | null): string {
  return sheetId ? `${TARGET}?sheet=${encodeURIComponent(sheetId)}` : TARGET;
}

/** What the user is handed to look at the result: the progress sheet's tab and each group's CLS draft, once saved. */
function links(sheetId: string | undefined, groups: Record<string, any>[]): Record<string, any> {
  return { progress_sheet: sheetUrl(sheetId),
    cls: groups.map(g => ({ group: g.group, draft: g.scripts_imported?.url ?? g.draft_saved?.url ?? null })) };
}

/** Local audit report, derived from immutable events and validated receipts; no network. */
export function report(dir: string): Record<string, any> {
  const { path: batchPath, manifest } = loadBatch(dir);
  const records = events(batchPath);
  const plan = manifest.plan as Plan;
  const state = status(batchPath);
  const groups: Record<string, any>[] = [];
  for (const group of plan.groups as Plan[]) {
    const result: Record<string, any> = { group: group.id, quantity: group.request.quantity, csv: path.join(batchPath, group.csv), steps: state.groups[group.id] };
    for (const event of records) {
      if (event.group === group.id && (event.step === 'draft_saved' || event.step === 'scripts_imported')) {
        const evidence = event.evidence;
        if (evidence.transport === 'cls_api') {
          validateBatchReceipt(batchPath, group.id, evidence, event.step);
          result[event.step] = { receipt: evidence.receipt, verified_at: event.time, draft_id: evidence.draft_id, url: evidence.url };
        }
      }
    }
    groups.push(result);
  }
  const context = 'api-plan.json' in manifest.artifacts ? readJson(path.join(batchPath, 'api-plan.json')) : {};
  const verified = [...records].reverse().find(e => e.step === 'append_verified');
  const result: Record<string, any> = {
    schema: 1, status: 'report_ready', plan_id: plan.plan_id, target: TARGET, worksheet: plan.worksheet, sheet_id: context.sheet_id ?? null,
    range: plan.range, state, groups, message: message(batchPath).message,
    evidence_time: '各阶段保存的回读时间；本报告不重新查询线上当前状态',
    links: links(context.sheet_id, groups),
  };
  if (verified) {
    const evidence = verified.evidence;
    if (evidence.transport === 'feishu_api' && evidence.snapshot) {
      const snapshotPath = path.resolve(evidence.snapshot);
      need(isInside(batchPath, snapshotPath), '报告快照必须位于本批目录');
      const snapshot = new Snapshot(snapshotPath);
      try {
        need(snapshot.fingerprint === evidence.snapshot_digest && verify(batchPath, snapshot, evidence.validations).status === 'complete',
          '报告对应的本地快照/规则证明已变化');
      } finally { snapshot.close(); }
    }
    result.append_verified = { verified_at: verified.time, evidence: verified.evidence };
  }
  return result;
}
