import fs from 'node:fs';
import path from 'node:path';
import { CellRange, columnLetter } from './a1.ts';
import { BRIDGE_VERSION, runBridge, type BridgeContext, type BridgeReply } from '../bridge.ts';
import { events, kindOf, loadBatch, preflight, record, report, sheetUrl, status, verify } from './batch.ts';
import { cellShown } from './brief.ts';
import { requirementName } from './cls.ts';
import { business, makePlan, type Plan } from './plan.ts';
import { itemsOf } from './request.ts';
import { acceptance, buildWrites, dropdowns, ruleProjection, ruleProof, type ApiRule } from './rules.ts';
import { checkSeal, seal } from './seal.ts';
import { FIELD_HEADERS, headerMatches, Snapshot } from './snapshot.ts';
import { Blocked, canonical, digest, NODE, need, readJson, TARGET, writeJsonNew } from './util.ts';

/**
 * The allowlisted Feishu transport: it calls the SDK bridge in this process (the same code the bridge command runs) and
 * orchestrates validate → write → read back → verify. No generic write, no v2 values write, no implicit retry, no target override.
 */

type Obj = Record<string, any>;
export const SCOPES = ['wiki:wiki:readonly', 'sheets:spreadsheet:readonly', 'sheets:spreadsheet:read', 'sheets:spreadsheet:write_only',
  'sheets:spreadsheet', 'drive:export:readonly', 'docx:document:readonly'];

/** An explicit non-empty-target refusal, not a timeout or permission failure. */
export class OccupiedRefusal extends Blocked {}

// Bridge failures whose message is ours (fixed text, already scrubbed of credentials) and may be shown as is.
const SHOWN_KINDS = new Set(['auth_required', 'config', 'identity_mismatch', 'scope_missing', 'invalid_request', 'login_denied', 'login_expired']);

export type BridgeRunner = (command: string, input: unknown) => Promise<BridgeReply>;

export class Bridge {
  readonly calls: Obj[] = [];
  private readonly run: BridgeRunner;

  constructor(run?: BridgeRunner, context: BridgeContext = {}) {
    this.run = run ?? ((command, input) => runBridge(command, input, context));
  }

  async call(name: string, payload?: unknown, options: { write?: boolean; path?: string } = {}): Promise<any> {
    const write = options.write === true;
    const started = Date.now();
    let reply: BridgeReply;
    try {
      reply = await this.run(name, payload === undefined ? {} : payload);
    } catch {
      throw new Blocked(write ? '接口写入结果未知，必须回读，不可重试' : '飞书桥调用失败');
    }
    this.calls.push({ command: [name], path: options.path ?? null, write, elapsed_ms: Date.now() - started, ok: reply.ok });
    // The bridge has already redacted credentials from the message (toPayload), so its reason can be passed on.
    need(reply && typeof reply === 'object' && typeof reply.ok === 'boolean', '飞书桥返回结构不匹配');
    if (!reply.ok) {
      const { kind, message } = reply.error;
      if (kind === 'occupied') throw new OccupiedRefusal('服务端明确拒绝写入非空目标');
      if (kind === 'unknown_result' || (write && kind === 'network')) throw new Blocked('接口写入结果未知，必须回读，不可重试');
      if (SHOWN_KINDS.has(kind)) throw new Blocked(`飞书不可用（${kind}）：${message}`);
      const code = (reply.error as { code?: number }).code;
      const reason = String(message ?? '').trim().slice(0, 300);
      throw new Blocked(`飞书接口调用失败（${kind}${code !== undefined ? `，错误码 ${code}` : ''}）${reason ? `：${reason}` : ''}${write ? '；写操作须回读核对' : ''}`);
    }
    Bridge.complete(reply.data);
    return reply.data;
  }

  /** A reply that mentions a failed item or truncated data is never taken as complete. */
  static complete(value: unknown): void {
    if (Array.isArray(value)) value.forEach(Bridge.complete);
    else if (value !== null && typeof value === 'object') {
      const v = value as Obj;
      need(v.ok !== false && v.success !== false && !(Array.isArray(v.errors) ? v.errors.length : v.errors) && !v.failed_count, '接口含失败项；停止并回读');
      need(!['partial_success', 'failure', 'failed', 'error'].includes(v.status), '接口返回部分成功或失败；停止并回读，不自动补写');
      need(!['truncated', 'is_truncated', 'has_more', 'hasMore'].some(k => v[k]), '接口数据被截断，不能证明安全');
      Object.values(v).forEach(Bridge.complete);
    }
  }

  /**
   * Is the Feishu login good right now? Unlike `doctor` this asks Feishu, and it says what is wrong instead of stopping:
   * ok | login_required | identity_mismatch | scopes_missing | unreachable | blocked.
   */
  async checkLogin(): Promise<Obj> {
    let reply: BridgeReply;
    try { reply = await this.run('auth-verify', {}); } catch { return { status: 'unreachable', reason: '飞书桥调用失败' }; }
    if (!reply || typeof reply !== 'object' || typeof reply.ok !== 'boolean') return { status: 'blocked', reason: '飞书桥返回结构不匹配' };
    if (reply.ok) {
      const data = reply.data as Obj;
      const missing: string[] = Array.isArray(data?.missing_scopes) ? data.missing_scopes : [];
      const who = { ...(data?.name ? { name: data.name } : {}) };
      return missing.length
        ? { status: 'scopes_missing', ...who, missing_scopes: missing, reason: '飞书登录缺少本流程必要的权限，需要重新授权' }
        : { status: 'ok', ...who };
    }
    const { kind, message } = reply.error;
    if (kind === 'auth_required') return { status: 'login_required', reason: message };
    if (kind === 'identity_mismatch') return { status: 'identity_mismatch', reason: message };
    if (kind === 'scope_missing') return { status: 'scopes_missing', reason: message };
    if (kind === 'network') return { status: 'unreachable', reason: '暂时连不上飞书，稍后再查；这不说明登录失效' };
    if (SHOWN_KINDS.has(kind)) return { status: 'blocked', reason: message };
    return { status: 'blocked', reason: '飞书接口调用失败，无法确认登录状态' };
  }

  async doctor(): Promise<Obj> {
    const info = await this.call('info');
    need(info.bridge === BRIDGE_VERSION, '飞书桥版本与技能不匹配');
    need(info.app_configured === true, '未配置飞书应用（FEISHU_APP_ID / FEISHU_APP_SECRET），由宿主或管理员配置');
    const auth = await this.call('auth-status');
    need(auth.logged_in === true, '飞书尚未授权：用 feishu_auth_login 工具，或 gof.mjs feishu login start 取得授权链接交给用户确认');
    await this.checkScopes(SCOPES);
    return { version: BRIDGE_VERSION, node: info.node, logged_in: true, identity: 'user', user_name: auth.name, open_id: auth.open_id,
      storage: auth.storage, required_scopes: SCOPES };
  }

  async checkScopes(required: string[]): Promise<void> {
    const checked = await this.call('auth-check-scopes', { required });
    need(checked.complete === true && !(checked.missing ?? []).length && required.every(s => (checked.granted ?? []).includes(s)),
      '飞书用户身份缺少本流程必要权限，需重新授权');
  }

  async apiRead(apiPath: string, params: Obj = {}): Promise<any> {
    need(apiPath.startsWith('/open-apis/') && !apiPath.includes('..') && !apiPath.includes('?'), '非法 API 路径');
    return this.call('api-get', { path: apiPath, params }, { path: apiPath });
  }

  async revision(token: string): Promise<any> {
    need(/^[A-Za-z0-9]+$/.test(token), '非法表格 token');
    return this.call('sheets-revision', { token });
  }

  async exportSheet(token: string, output: string): Promise<any> {
    need(/^[A-Za-z0-9]+$/.test(token), '非法表格 token');
    return this.call('sheets-export', { token, output });
  }

  /** The only write: every range goes out with allow_overwrite=false, which the server enforces. */
  async cellsSet(token: string, writes: Obj[]): Promise<any> {
    need(/^[A-Za-z0-9]+$/.test(token), '非法表格 token');
    need(Array.isArray(writes) && writes.length > 0 && writes.every(w => w.allow_overwrite === false), '缺少不可覆盖保护');
    return this.call('sheets-cells-set', { token, writes }, { write: true });
  }

  /** Adds one option to the existing dropdown of one column span; every rule variant keeps its own options and colors. */
  async dropdownAdd(args: Obj): Promise<any> {
    need(/^[A-Za-z0-9]+$/.test(args.token), '非法表格 token');
    return this.call('sheets-dropdown-add', args, { write: true });
  }

  async createWorkbook(title: string): Promise<any> {
    return this.call('sheets-create', { title }, { write: true });
  }
}

async function revisionOf(bridge: Bridge, token: string): Promise<number> {
  const value = (await bridge.revision(token)).revision;
  need(Number.isInteger(value) && value >= 0, '无法读取文档版本');
  return value;
}

export async function target(bridge: Bridge): Promise<string> {
  const data = await bridge.apiRead('/open-apis/wiki/v2/spaces/get_node', { token: NODE, obj_type: 'wiki' });
  const node = data.node ?? {};
  need(node.node_token === NODE && node.obj_type === 'sheet', '目标不是获准测试节点的电子表格');
  const token = node.obj_token ?? '';
  need(/^[A-Za-z0-9]+$/.test(token), '缺少真实表格 token');
  return token;
}

export async function sheetsOf(bridge: Bridge, token: string): Promise<Obj[]> {
  const data = await bridge.apiRead(`/open-apis/sheets/v3/spreadsheets/${token}/sheets/query`);
  const found = data.sheets;
  need(Array.isArray(found) && found.length > 0, '无法列出完整工作表');
  need(found.every((s: Obj) => s.resource_type === 'sheet'), '含无法校验的非网格工作表');
  need(new Set(found.map((s: Obj) => s.title)).size === found.length, '工作表标题不唯一');
  return found;
}

/** Names and types only, never values: enough to see how a reply differs from the documented one without echoing an untrusted body. */
function shapeOf(data: any, sid: string): string {
  if (data === null || typeof data !== 'object') return `返回 ${data === null ? 'null' : typeof data}`;
  const keys = Object.keys(data).slice(0, 12).map(k => `${k.replace(/[^A-Za-z0-9_]/g, '?').slice(0, 24)}:${Array.isArray(data[k]) ? 'array' : data[k] === null ? 'null' : typeof data[k]}`);
  const sheet = data.sheetId === undefined ? 'sheetId 缺失' : data.sheetId === sid ? 'sheetId 一致' : 'sheetId 与请求不同';
  return `${sheet}；字段 ${keys.join(',') || '无'}`;
}

/** Feishu reports a color in the case it likes (the ones just written come back upper case, old ones lower case); a color is the same color either way. */
function lowerColors(colors: Obj): Record<string, string> {
  return Object.fromEntries(Object.entries(colors).map(([option, color]) => [option, String(color).toLowerCase()]));
}

export async function readRules(bridge: Bridge, token: string, metadata: Obj[]): Promise<ApiRule[]> {
  const result: ApiRule[] = [];
  for (const sheet of metadata) {
    const sid: string = sheet.sheet_id;
    const rows = sheet.grid_properties.row_count;
    const cols = sheet.grid_properties.column_count;
    need(Number.isInteger(rows) && Number.isInteger(cols) && rows * cols > 0 && rows * cols <= 4_000_000, '规则读取范围无法证明完整');
    for (let r = 1; r <= rows; r += 5000) {
      for (let c = 1; c <= cols; c += 100) {
        const rect = `${columnLetter(c)}${r}:${columnLetter(Math.min(c + 99, cols))}${Math.min(r + 4999, rows)}`;
        const data = await bridge.apiRead(`/open-apis/sheets/v2/spreadsheets/${token}/dataValidation`,
          { range: `${sid}!${rect}`, dataValidationType: 'list' });
        // Feishu omits `dataValidations` when the range holds no dropdown (the docs say an empty array), so absent means none. The reply
        // must still be this sheet's own and carry the workbook's revision, so a reply of some other shape never reads as "no rules".
        const none = data?.dataValidations === undefined && typeof data?.revision === 'number' && typeof data?.spreadsheetToken === 'string';
        need(data !== null && typeof data === 'object' && data.sheetId === sid && (none || Array.isArray(data.dataValidations)),
          `下拉规则返回结构不匹配（${shapeOf(data, sid)}）`);
        for (const rule of (none ? [] : data.dataValidations) as Obj[]) {
          const opts: Obj = rule.options ?? {};
          const values = rule.conditionValues;
          need(rule.dataValidationType === 'list' && Array.isArray(values) && values.every((v: unknown) => typeof v === 'string')
            && new Set(values).size === values.length, '下拉来源或选项不支持可靠保留');
          const colors: Obj = opts.colorValueMap ?? {};
          need(colors !== null && typeof colors === 'object' && !Array.isArray(colors) && Object.keys(colors).every(k => values.includes(k)), '下拉颜色映射异常');
          need(typeof (opts.multipleValues ?? false) === 'boolean' && typeof (opts.highlightValidData ?? false) === 'boolean'
            && Object.values(colors).every(color => typeof color === 'string' && /^#[0-9a-fA-F]{6}$/.test(color)), '下拉模式/颜色格式无法可靠保留');
          const ranges: string[] = [];
          for (const raw of (rule.ranges ?? []) as string[]) {
            const cut = raw.indexOf('!');
            need(cut > 0 && raw.slice(0, cut) === sid, '下拉范围跨表或无法解析');
            ranges.push(new CellRange(raw.slice(cut + 1)).toString());
          }
          need(ranges.length > 0, '下拉范围为空');
          result.push({ sheet_id: sid, ranges, type: 'list', options: values, multiple: opts.multipleValues ?? false,
            highlight: opts.highlightValidData ?? false, colors: lowerColors(colors) });
        }
      }
    }
  }
  return result;
}

async function exportSnapshot(bridge: Bridge, token: string, output: string): Promise<Snapshot> {
  const file = path.resolve(output);
  need(file.toLowerCase().endsWith('.xlsx') && !fs.existsSync(file), '快照必须为新的 XLSX 文件');
  await bridge.exportSheet(token, file);
  need(fs.existsSync(file) && fs.statSync(file).isFile(), '导出任务未落盘，不能继续；按官方返回的任务引用只读查询，不重新提交导出');
  return new Snapshot(file);
}

export async function apiPlan(bridge: Bridge, snapshot: Snapshot, plan: Plan): Promise<Obj> {
  const token = await target(bridge);
  const before = await revisionOf(bridge, token);
  const metadata = await sheetsOf(bridge, token);
  need(canonical([...metadata].sort((a, b) => a.index - b.index).map(s => s.title)) === canonical(snapshot.sheetNames), 'API 工作表列表与 XLSX 不匹配');
  const sheet = metadata.find(s => s.title === plan.worksheet);
  need(sheet, 'API 工作表列表与 XLSX 不匹配');
  const records = await readRules(bridge, token, metadata);
  need(before === await revisionOf(bridge, token), '读取期间表格变化，需要新快照及新计划');
  return seal({ schema: 1, bridge_version: BRIDGE_VERSION, target: TARGET, batch_plan_id: plan.plan_id, baseline_digest: snapshot.fingerprint,
    spreadsheet_token: token, sheet_id: sheet.sheet_id, revision: before, metadata, rules: records,
    dropdowns: dropdowns(plan, sheet.sheet_id, records) }, 'api_plan_id');
}

/** The one production write: only after the isolated probe receipt, once per batch, then read back and verified. */
export async function execute(bridge: Bridge, dir: string, receipt: string): Promise<Obj> {
  const { path: batchPath, manifest } = loadBatch(dir);
  need(!events(batchPath).some(e => e.step === 'append_started'), '已有接口写入尝试；只能回读验收，不再次发送');
  const context = readJson(path.join(batchPath, 'api-plan.json'));
  checkSeal(context, 'api_plan_id');
  const approved = acceptance(receipt, BRIDGE_VERSION);
  await bridge.doctor();
  const token = await target(bridge);
  need(token === context.spreadsheet_token && approved.production_token === token, '目标与安全验证记录不匹配');
  const attempt = path.join(batchPath, `api-attempt-${String(events(batchPath).length + 1).padStart(6, '0')}`);
  // No append_started yet (checked above), so a folder of that name is what a killed, unsent attempt left behind.
  fs.rmSync(attempt, { recursive: true, force: true });
  fs.mkdirSync(attempt);
  let fresh: Snapshot | undefined;
  let started = false;
  try {
    need(await revisionOf(bridge, token) === context.revision, '表格版本变化，必须更新计划');
    fresh = await exportSnapshot(bridge, token, path.join(attempt, 'preflight.xlsx'));
    preflight(batchPath, fresh);
    const currentRules = await readRules(bridge, token, await sheetsOf(bridge, token));
    need(canonical(ruleProjection(currentRules)) === canonical(ruleProjection(context.rules)), '下拉规则变化，必须更新计划');
    need(await revisionOf(bridge, token) === context.revision, '检查期间出现并发变化');
    const writes = buildWrites(manifest.plan, context);
    writeJsonNew(path.join(attempt, 'writes.json'), writes);
    record(batchPath, 'append_started', null, { transport: 'feishu_api', api_plan_id: context.api_plan_id, request_digest: digest(writes) });
    started = true;
    await bridge.cellsSet(token, writes);
    fresh.close();
    const writtenRevision = await revisionOf(bridge, token); // the export and the rules below must be of this very revision
    fresh = await exportSnapshot(bridge, token, path.join(attempt, 'after.xlsx'));
    const postRevision = await revisionOf(bridge, token);
    need(postRevision === writtenRevision, '导出期间出现并发变化');
    const afterRules = await readRules(bridge, token, await sheetsOf(bridge, token));
    need(postRevision === await revisionOf(bridge, token), '验收期间出现并发变化');
    ruleProof(path.join(attempt, 'rule-proof.json'), fresh, afterRules, context, manifest.plan);
    const evidence = { transport: 'feishu_api', proof: path.join(attempt, 'rule-proof.json') };
    const result = verify(batchPath, fresh, evidence);
    need(result.status === 'complete', '追加未完整通过验收；不自动补写或回滚');
    record(batchPath, 'append_verified', null, { transport: 'feishu_api', validations: evidence, calls: bridge.calls, revision: postRevision,
      snapshot: fresh.path, snapshot_digest: fresh.fingerprint }, fresh);
    const reportPath = path.join(attempt, 'verification-report.json');
    writeJsonNew(reportPath, report(batchPath));
    return { status: 'append_verified', batch: batchPath, worksheet: manifest.plan.worksheet, sheet_id: context.sheet_id, sheet_url: sheetUrl(context.sheet_id),
      range: manifest.plan.range, report: reportPath, calls: bridge.calls };
  } catch (error) {
    if (started && !status(batchPath).blocked) {
      record(batchPath, 'blocked', null, { reason: '飞书接口写入/验收失败或结果未知；先回读，不重试', transport: 'feishu_api' });
    }
    throw error;
  } finally {
    fresh?.close();
    // Nothing was sent: the attempt directory holds only a preflight export, and a retry must be able to use its name again.
    if (!started) fs.rmSync(attempt, { recursive: true, force: true });
  }
}

/** Only after a separately approved online test plan; creates a new isolated workbook. */
export async function probe(bridge: Bridge, receipt: string): Promise<Obj> {
  need(!fs.existsSync(receipt), '隔离验证记录不能覆盖');
  await bridge.doctor();
  await bridge.checkScopes(['sheets:spreadsheet:create']);
  const production = await target(bridge);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '_').replace('.', '_').replace('Z', '');
  const created = await bridge.createWorkbook(`GOFCN_API_SAFETY_${stamp}`);
  const token = created.spreadsheet_token;
  need(token && token !== production, '隔离表创建结果未知，禁止继续/重复创建');
  const sid = (await sheetsOf(bridge, token))[0]!.sheet_id as string;
  const write = (rect: string, cells: Obj[][]) => bridge.cellsSet(token, [{ sheet_id: sid, range: rect, cells, allow_overwrite: false }]);
  const read = async () => {
    const reply = await bridge.apiRead(`/open-apis/sheets/v2/spreadsheets/${token}/values_batch_get`, { ranges: `${sid}!A1:B1`, valueRenderOption: 'Formula' });
    need(Array.isArray(reply.valueRanges) && reply.valueRanges.length === 1, '探测回读结构不匹配');
    return reply.valueRanges[0].values;
  };
  await write('A1:B1', [[{ value: 'KEEP_EXISTING' }, { formula: '=IF(1=1,"","")' }]]);
  const expected = [['KEEP_EXISTING', '=IF(1=1,"","")']];
  need(canonical(await read()) === canonical(expected), '隔离基线写入/公式不匹配');
  const passed: string[] = [];
  const observations: Obj[] = [];
  for (const [name, rect] of [['occupied_value', 'A1:A1'], ['empty_formula', 'B1:B1'], ['repeated_occupancy', 'A1:B1']] as const) {
    const width = new CellRange(rect).maxCol - new CellRange(rect).minCol + 1;
    let rejected = false;
    const before = await read();
    try {
      await write(rect, [Array.from({ length: width }, () => ({ value: 'MUST_NOT_REPLACE' }))]);
    } catch (error) {
      if (!(error instanceof OccupiedRefusal)) throw error;
      rejected = true;
    }
    const after = await read();
    need(rejected && canonical(before) === canonical(after) && canonical(after) === canonical(expected), '防覆盖探测失败，生产接口追加保持禁用');
    passed.push(name);
    observations.push({ case: name, rejection: 'non_empty', before, after });
  }
  const data = seal({ schema: 2, bridge_version: BRIDGE_VERSION, identity: 'user', probe_workbook: token, production_token: production, passed,
    created_at: new Date().toISOString(), observations, calls: bridge.calls }, 'receipt_id');
  writeJsonNew(receipt, data);
  return { status: 'safety_verified', receipt: path.resolve(receipt), probe_url: `https://centurygames.feishu.cn/sheets/${token}`, calls: bridge.calls };
}

/** Re-read an existing batch without sending a write, even after an unknown result. */
export async function reconcile(bridge: Bridge, dir: string): Promise<Obj> {
  const { path: batchPath, manifest } = loadBatch(dir);
  const context = readJson(path.join(batchPath, 'api-plan.json'));
  checkSeal(context, 'api_plan_id');
  await bridge.doctor();
  const token = await target(bridge);
  need(token === context.spreadsheet_token && context.bridge_version === BRIDGE_VERSION, '回读目标或版本与原批次不符');
  const output = path.join(batchPath, `api-readback-${new Date().toISOString().replace(/[-:.]/g, '')}`);
  fs.mkdirSync(output);
  let fresh: Snapshot | undefined;
  try {
    const before = await revisionOf(bridge, token);
    fresh = await exportSnapshot(bridge, token, path.join(output, 'fresh.xlsx'));
    const rules = await readRules(bridge, token, await sheetsOf(bridge, token));
    need(before === await revisionOf(bridge, token), '回读期间表格变化，不能生成验收证据');
    ruleProof(path.join(output, 'rule-proof.json'), fresh, rules, context, manifest.plan);
    const evidence = { transport: 'feishu_api', proof: path.join(output, 'rule-proof.json') };
    const result = verify(batchPath, fresh, evidence);
    writeJsonNew(path.join(output, 'readback-report.json'), { verification: result, revision: before, snapshot_digest: fresh.fingerprint, calls: bridge.calls });
    return { ...result, snapshot: fresh.path, validation_evidence: evidence, report: path.join(output, 'readback-report.json') };
  } finally {
    fresh?.close();
  }
}

/** The device authorization the MCP tools run, for when those tools are not available. Never prints a token. */
export async function login(bridge: Bridge, action: string, options: { wait?: number; probeScope?: boolean } = {}): Promise<any> {
  if (action === 'start') return bridge.call('auth-login', { extra_scopes: options.probeScope ? ['sheets:spreadsheet:create'] : [] });
  if (action === 'poll') {
    const wait = options.wait ?? 40;
    need(Number.isInteger(wait) && wait >= 0 && wait <= 50, '--wait 必须在 0 到 50 秒之间');
    return bridge.call('auth-poll', { wait_ms: wait * 1000 });
  }
  if (action === 'status') return bridge.call('auth-status');
  need(action === 'logout', `未知登录动作：${action}`);
  return bridge.call('auth-logout');
}

/** The progress columns whose dropdown may gain an option, by the name `dropdown-add --field` takes (the plan's field names work too). */
export const OPTION_FIELDS: Record<string, string> = { primary: 'primary_tag', secondary: 'secondary_tag', form: 'creative_form', supplier: 'supplier', reviewer: 'creator' };
const TAG_COLORS = ['#bacefd', '#d9f5d6', '#fed4a4', '#ece2fe', '#f8def8', '#b1e8fc', '#fbbfbc', '#f8e6ab'];
const rowCap = 5000;

/**
 * Adds a missing option to the dropdown of a whole column of one sheet: 一级标签, 二级标签, 创意形式, 设计师供应商 or 创意者脚本审核人. Only
 * for a value the request needs and the dropdown lacks: the caller (the agent) checks that and put it in the approved plan. Existing
 * options, colors, modes and cell values are not changed.
 */
export async function addOption(bridge: Bridge, fieldName: string, option: string, sheetName: string, color?: string): Promise<Obj> {
  const field = OPTION_FIELDS[fieldName] ?? (Object.values(OPTION_FIELDS).includes(fieldName) ? fieldName : undefined);
  need(field, '--field 必须是 primary、secondary、form、supplier 或 reviewer');
  await bridge.doctor();
  const token = await target(bridge);
  const sheet = (await sheetsOf(bridge, token)).find(s => s.title === sheetName);
  need(sheet, `找不到工作表：${sheetName}`);
  const sid = sheet.sheet_id as string;
  const width = Math.min(Math.max(Number(sheet.grid_properties?.column_count) || 26, 1), 100);
  const header = (await bridge.apiRead(`/open-apis/sheets/v2/spreadsheets/${token}/values_batch_get`, { ranges: `${sid}!A1:${columnLetter(width)}1` })).valueRanges?.[0]?.values?.[0];
  need(Array.isArray(header), '读不到表头');
  const hits = (header as unknown[]).flatMap((cell, i) => headerMatches(field, cellShown(cell)) ? [i] : []);
  need(hits.length === 1, `表头里找不到唯一的${FIELD_HEADERS[field]}列`);
  const column = columnLetter(hits[0]! + 1);
  const chosen = color ?? TAG_COLORS[[...option].reduce((n, c) => n + c.codePointAt(0)!, 0) % TAG_COLORS.length]!;
  const rows = Number(sheet.grid_properties?.row_count);
  need(Number.isInteger(rows) && rows >= 2, '读不到工作表行数');
  const updated: Obj[] = [];
  for (let first = 2; first <= rows; first += rowCap) {
    const last = Math.min(first + rowCap - 1, rows);
    try {
      updated.push(await bridge.dropdownAdd({ token, sheet_id: sid, column, first_row: first, last_row: last, option, color: chosen }));
    } catch (e) {
      // A span with no dropdown at all, or one that already has the option, is simply not part of this change.
      if (!/没有现有下拉|都已包含/.test((e as Error).message)) throw e;
    }
  }
  need(updated.length > 0, '没有任何范围需要新增该选项（已存在，或该列没有下拉）');
  return { sheet: sheetName, field, column, option, updated_ranges: updated.reduce((n, u) => n + Number(u.updated_ranges), 0) };
}

export async function takeSnapshot(bridge: Bridge, output: string): Promise<Obj> {
  await bridge.doctor();
  const token = await target(bridge);
  const before = await revisionOf(bridge, token);
  const snap = await exportSnapshot(bridge, token, output);
  try {
    need(before === await revisionOf(bridge, token), '导出期间版本变化，快照不可用于执行');
    return { snapshot: snap.path, snapshot_digest: snap.fingerprint, revision: before };
  } finally { snap.close(); }
}

export async function planWithApi(bridge: Bridge, snapshot: Snapshot, requestInput: unknown): Promise<Obj> {
  await bridge.doctor();
  const offline = makePlan(snapshot, requestInput);
  return { batch_plan: offline, api_plan: await apiPlan(bridge, snapshot, offline) };
}

export async function recomputeApiPlan(bridge: Bridge, snapshot: Snapshot, approved: Obj): Promise<Obj> {
  await bridge.doctor();
  const recomputed = await apiPlan(bridge, snapshot, approved.batch_plan);
  need(canonical(recomputed) === canonical(approved.api_plan), '接口目标/版本/规则与获批计划变化');
  return recomputed;
}

/**
 * The approved plan made again on a fresh snapshot, for the append. The rows, their numbers, values and names and the groups must be
 * exactly the approved ones, or the user has to approve again; the revision and the rules are taken as they are now, since the approved
 * dropdown additions (and anybody's edits elsewhere in the workbook) change them without changing what is written.
 */
export async function recomputePlan(bridge: Bridge, snapshot: Snapshot, approved: Obj): Promise<Obj> {
  const plan = approved?.batch_plan;
  need(plan && typeof plan === 'object' && approved.api_plan && typeof approved.api_plan === 'object', '获批计划不完整');
  const { plan_id: id, ...unsealed } = plan;
  need(digest(unsealed).slice(0, 24) === id, '获批计划被修改过');
  checkSeal(approved.api_plan, 'api_plan_id');
  await bridge.doctor();
  const fresh = makePlan(snapshot, plan.request, plan.current_sheet);
  need(canonical(business(fresh)) === canonical(business(plan)), '进度表新增行、素材编号或名称与获批计划不同（表格已有新变化），需更新计划并重新确认');
  const api = await apiPlan(bridge, snapshot, fresh);
  need(api.spreadsheet_token === approved.api_plan.spreadsheet_token && api.sheet_id === approved.api_plan.sheet_id, '接口目标与获批计划不同');
  return { batch_plan: fresh, api_plan: api };
}

const OPTION_NAMES = Object.fromEntries(Object.entries(OPTION_FIELDS).map(([name, field]) => [field, name]));

/** The few lines of a plan the agent shows the user: sheet, numbers, what each group's rows are called, and the dropdown options to add. */
export function planSummary(result: Obj, file: string): Obj {
  const plan = result.batch_plan;
  const api = result.api_plan;
  return {
    status: 'plan_saved', plan: file, worksheet: plan.worksheet, sheet_id: api.sheet_id, range: plan.range, quantity: plan.quantity,
    first_number: plan.first_number, last_number: plan.last_number,
    groups: (plan.groups as Obj[]).map(g => {
      let offset = 0;
      const items = itemsOf(g.request).map(item => {
        const names = (g.names as string[]).slice(offset, offset + item.quantity);
        offset += item.quantity;
        return { quantity: item.quantity, first: names[0], last: names[names.length - 1] };
      });
      // `message_kind` is how the group message will name this requirement ("素人剧情*25"), shown in the plan so it can be corrected before.
      return { group: g.id, quantity: g.request.quantity, requirement_name: requirementName(g.names), supplier: g.request.supplier,
        reviewer: g.request.reviewer, script_url: g.request.script_url, message_kind: kindOf(g.request), items };
    }),
    // Read from the rules through the API: the options the XLSX export lists for a column are not reliable.
    new_options: (api.dropdowns as Obj[]).flatMap(d => (d.missing as string[]).map(option => ({ field: OPTION_NAMES[d.field] ?? d.field, option }))),
    history_warnings: (plan.history_warnings as string[]).length,
  };
}
