import fs from 'node:fs';
import path from 'node:path';
import { clsCheck, events, groupFor, loadBatch } from './batch.ts';
import { normalizeRequest, type Group } from './request.ts';
import { checkSeal, rejectSecrets, seal } from './seal.ts';
import { Blocked, canonical, CSV_HEADERS, FIXED_TAG, isInside, need, readJson, sha256 } from './util.ts';

/** Offline CLS operation builder and receipt validator. Never stores credentials or sends HTTP. */

type Obj = Record<string, any>;
export const TAG_NAMES = [FIXED_TAG, '玩法卖点（单选必选）/展示向/展示向'];

function unique<T>(items: T[], predicate: (item: T) => boolean, label: string): T {
  const found = items.filter(predicate);
  need(found.length === 1, `${label} 不存在或匹配不唯一，需在计划前澄清`);
  return found[0]!;
}

function userMatch(user: Obj, wanted: string): boolean {
  if (user.name === wanted) return true;
  return [...String(user.name).matchAll(/[（(]([^（）()]+)[）)]/g)].some(m => m[1] === wanted);
}

function dateValue(value: unknown): string {
  need(value === '' || typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value), '日期需先明确为 YYYY-MM-DD；不猜测日期');
  return value as string;
}

const AMOUNT = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/** A decimal amount as a number, or undefined when the text is not a plain decimal number. */
function amount(value: unknown): number | undefined {
  const text = String(value).trim();
  if (!AMOUNT.test(text)) return undefined;
  const n = Number(text);
  return Number.isFinite(n) ? n : undefined;
}

/** CLS requirement name: the group's first and last material number, e.g. GOFCN67294-GOFCN67299 (one item: GOFCN67294). */
export function requirementName(names: string[]): string {
  const numbers = names.map(n => /^GOFCN(\d+)_/.exec(n)?.[1]);
  need(numbers.length > 0 && numbers.every(n => n !== undefined), '素材名称缺少 GOFCN 编号，无法生成需求名称');
  const first = `GOFCN${numbers[0]}`;
  const last = `GOFCN${numbers[numbers.length - 1]}`;
  return first === last ? first : `${first}-${last}`;
}

export function buildPayload(group: Group, catalog: Obj, names?: string[]): [Obj, number, Obj] {
  const cls = group.cls;
  need(Object.keys(cls).length > 0 && group.brief.trim() !== '', '全流程 CLS 字段/备注未收齐');
  const game = unique<Obj>(catalog.games, x => x.code === 'GOFCN', 'GOFCN 项目');
  const userGames = catalog.account?.game_ids;
  need(Array.isArray(userGames) && userGames.includes(game.id), '当前账号未证明有 GOFCN 权限');
  const direction = unique<Obj>(catalog.directions, x => x.game_id === game.id && x.name === cls.direction, '创意方向');
  const supplier = unique<Obj>(catalog.users, x => x.status === 1 && x.roles.includes('outsource') && userMatch(x, group.supplier), '供应商');
  const creator = unique<Obj>(catalog.users, x => x.status === 1 && x.name === group.reviewer, '创意人');
  const task = unique<Obj>(catalog.types, x => x.type === 'creative' && x.key === cls.task_type, '任务类型');
  const payload: Obj = {
    game_id: game.id, direct_id: direction.id, asset_data: '', name: names ? requirementName(names) : 'GOFCN<首号>-GOFCN<末号>', type: task.value, company: '',
    departments: [], marketing_user_id: '', third_user_id: supplier.id, currency: 'cny', price: 0, price_reason: group.brief,
    expect_end_date: '', storyboard_end_date: '', storyboard_attaches: [], draft_end_date: '', draft_attaches: [],
    film_end_date: '', film_attaches: [], status: -2,
  };
  if (cls.currency) payload.currency = unique<Obj>(catalog.currencies, x => cls.currency === x.key || cls.currency === x.value, '货币').value;
  if ((cls.quotation ?? '') !== '') {
    const text = String(cls.quotation).trim();
    if (/^[+-]?(?:nan|snan|inf|infinity)$/i.test(text)) throw new Blocked('报价无效');
    const price = amount(cls.quotation);
    need(price !== undefined, '报价必须是已确认的金额');
    need(price >= 0, '报价无效');
    payload.price = price;
  }
  for (const [key, options, field] of [['subject', 'companies', 'company'], ['department', 'departments', 'departments']] as const) {
    if (cls[key]) {
      const value = unique<Obj>(catalog[options], x => cls[key] === x.key || cls[key] === x.value, key).value;
      payload[field] = key === 'department' ? [value] : value;
    }
  }
  if (cls.market_contact) {
    payload.marketing_user_id = unique<Obj>(catalog.users, x => x.status === 1 && x.name === cls.market_contact, '市场媒介').id;
  }
  for (const [key, field] of [['expected_completion', 'expect_end_date'], ['storyboard_time', 'storyboard_end_date'],
    ['first_draft_time', 'draft_end_date'], ['final_cut_time', 'film_end_date']] as const) payload[field] = dateValue(cls[key] ?? '');
  const defaults: Obj = {};
  for (const [key, source] of [['currency', 'currency'], ['price', 'quotation']] as const) if ((cls[source] ?? '') === '') defaults[key] = payload[key];
  return [payload, creator.id, defaults];
}

/** RFC 4180 reading of the generated CSV. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function csvData(dir: string, group: Obj): Obj {
  const raw = fs.readFileSync(path.join(dir, group.csv));
  need(raw.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) && raw.includes('\r\n'), 'CSV 编码或换行不符');
  const rows = parseCsv(raw.toString('utf8').slice(1));
  const expected = [CSV_HEADERS, ...group.names.map((name: string, i: number) => [name, i === 0 ? group.request.script_url : '同上', FIXED_TAG])];
  need(canonical(rows) === canonical(expected), 'CSV 与获批组不一致，禁止导入');
  return { filename: group.csv, sha256: sha256(raw), base64: raw.toString('base64') };
}

export function operation(dir: string, groupId: string, action: string, catalog: Obj, observations: Obj): Obj {
  const { path: batchPath, manifest } = loadBatch(dir);
  rejectSecrets(catalog);
  need(['save_draft', 'import_scripts'].includes(action), '只允许草稿创建和脚本导入');
  const group = groupFor(manifest.plan, groupId);
  need(catalog.can_create === true && catalog.account?.status === 1, '未证明当前 CLS 登录及建单权限');
  clsCheck(batchPath, groupId, action, observations);
  const [payload, creatorId, defaults] = buildPayload(group.request, catalog, group.names);
  const expected = { names: group.names, quantity: group.request.quantity, creator_id: creatorId, link: group.request.script_url,
    tag_names: [...TAG_NAMES].sort() };
  const result: Obj = { schema: 1, action, plan_id: manifest.plan.plan_id, group: groupId, account_id: catalog.account.id, payload,
    native_defaults: defaults, expected };
  if (action === 'import_scripts') {
    const saved = events(batchPath).filter(e => e.group === groupId && e.step === 'draft_saved');
    need(saved.length === 1 && saved[0]!.evidence.draft_id, '原批次没有可核对的草稿 ID；先核对旧工单');
    result.draft_id = saved[0]!.evidence.draft_id;
    result.csv = csvData(batchPath, group);
  }
  return seal(result, 'operation_id');
}

const ALLOWED_POST = ['/api/workflow/script/save', '/api/workflow/sub-script/multiple-add'];

export function validateReceipt(evidence: Obj): Obj {
  const receipt = readJson(String(evidence.receipt ?? ''));
  rejectSecrets(receipt);
  need(receipt.schema === 1 && receipt.transport === 'cls_api' && receipt.status === 'verified' && receipt.unpublished === true,
    '缺少已回读验证的 CLS 接口记录');
  const parent = receipt.parent ?? {};
  need(Number.isInteger(parent.id) && parent.id > 0 && parent.status === -2, 'CLS 需求未证明为草稿');
  need(evidence.draft_id === parent.id && evidence.url === `https://creative.centurygames.cn/requirement/${parent.id}/edit-outer`,
    '草稿入口与接口 ID 不匹配');
  if (evidence.requirement_number !== undefined && evidence.requirement_number !== null) {
    need(evidence.requirement_number === parent.number, '需求编号不是实际接口返回值');
  }
  const calls: Obj[] = receipt.calls ?? [];
  for (const call of calls) {
    const allowed = (call.method === 'POST' && ALLOWED_POST.includes(call.path)) || (call.method === 'GET' && call.path === `/api/workflow/script/${parent.id}`);
    need(allowed && call.business_code === 0 && call.http_status >= 200 && call.http_status < 300, '接口调用记录包含失败或未许可动作');
  }
  need(calls.length > 0, '接口记录没有回读证据');
  const last = calls[calls.length - 1]!;
  need(last.method === 'GET' && last.path === `/api/workflow/script/${parent.id}`, '接口记录必须以完整草稿回读结束');
  need(calls.filter(c => c.method === 'POST').length <= 1, '接口记录包含重复写请求');
  return receipt;
}

function validateParent(parent: Obj, payload: Obj): void {
  for (const [key, expected] of Object.entries(payload)) {
    if (key === 'asset_data') continue; // This field belongs to the separate asset object; always blank in this skill.
    const actual = parent[key];
    let equal: boolean;
    if (key === 'price') {
      const a = amount(actual);
      const b = amount(expected);
      equal = a !== undefined && b !== undefined && a === b;
    } else if (expected === '' && (actual === null || actual === undefined)) equal = true; // Backend persists unfilled dates/optional IDs as null.
    else equal = canonical(actual) === canonical(expected);
    need(equal, `CLS 回读字段不符：${key}`);
  }
}

export function validateBatchReceipt(dir: string, groupId: string, evidence: Obj, step: string): void {
  const { path: batchPath, manifest } = loadBatch(dir);
  const receiptPath = path.resolve(String(evidence.receipt ?? ''));
  const operationPath = path.resolve(String(evidence.operation ?? ''));
  need(isInside(batchPath, receiptPath) && isInside(batchPath, operationPath), 'CLS 记录必须位于本批目录');
  const op = readJson(operationPath);
  checkSeal(op, 'operation_id');
  need(op.plan_id === manifest.plan.plan_id && op.group === groupId, '接口记录不属于本批/本组');
  const receipt = validateReceipt(evidence);
  need(receipt.parent.user_id === op.account_id && (receipt.parent.for_internal === 0 || receipt.parent.for_internal === false), '草稿账号/外包归属不符');
  need(receipt.operation_id === op.operation_id && receipt.action === op.action, '接口请求摘要不匹配');
  const attempts = events(batchPath).filter(e => e.group === groupId && e.step === 'cls_api_attempt' && e.evidence.operation_id === op.operation_id);
  need(attempts.length === 1, '必须先记录本次接口尝试；不可重复请求');
  const group = groupFor(manifest.plan, groupId);
  need(op.payload.name === requirementName(group.names) && op.payload.price_reason === group.request.brief, '需求名称/备注与获批需求不符');
  need(canonical(op.expected.names) === canonical(group.names) && op.expected.creator_id > 0 && op.expected.link === group.request.script_url,
    '请求与获批需求不匹配');
  validateParent(receipt.parent, op.payload);
  const scripts: Obj[] = receipt.parent.sub_scripts ?? [];
  if (step === 'draft_saved') {
    need(op.action === 'save_draft' && scripts.length === 0, '新建草稿存在计划外脚本');
  } else {
    need(op.action === 'import_scripts' && receipt.parent.id === op.draft_id && scripts.length === group.names.length, '导入数量/草稿不符');
    need(new Set(scripts.map(s => s.id)).size === scripts.length, '返回脚本 ID 重复');
    scripts.forEach((script, index) => {
      need(script.name === group.names[index] && script.user_id === op.expected.creator_id
        && script.data === (index === 0 ? op.expected.link : '同上')
        && (script.tags ?? []).some((t: Obj) => TAG_NAMES.includes(t.full_name)), '脚本名称/创意人/链接/标签不符');
    });
  }
}

export function clsPreview(requestInput: unknown, catalog: Obj): Obj {
  rejectSecrets(catalog);
  need(catalog.can_create === true, '没有建单权限');
  const request = normalizeRequest(requestInput);
  const groups = request.groups.map((group, offset) => {
    const [payload, creator, defaults] = buildPayload(group, catalog);
    return { group: String(offset + 1).padStart(2, '0'), payload, creator_id: creator, native_defaults: defaults };
  });
  return { status: 'cls_plan', groups };
}
