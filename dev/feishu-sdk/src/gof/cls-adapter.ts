import { createHash } from 'node:crypto';
import { parseCsv, TAG_NAMES } from './cls.ts';
import { canonical, Blocked, CSV_HEADERS } from './util.ts';

/*
 * The restricted CLS client: the only code that talks to CLS. It is built for one logged-in session and can do exactly what the
 * skill is allowed to do there: read the options, create an unpublished draft, import this batch's CSV into that draft, and read
 * the draft back. Publishing, deleting, updating existing requirements and uploading materials have no method and no allowed path.
 * Every write is checked against a sealed operation file first and is never retried; whatever it answers is read back and compared.
 */

type Obj = Record<string, any>;

export class ClsError extends Blocked {
  /** `unknown` after a write whose outcome is not known: the draft has to be read back before anything else is done. */
  readonly kind: 'blocked' | 'unknown';
  draftId: number | undefined;
  operationId: string | undefined;
  constructor(message: string, kind: 'blocked' | 'unknown' = 'blocked') {
    super(message);
    this.kind = kind;
  }
}

export interface ClsAdapterConfig {
  /** https://creative.centurygames.cn in production; tests use a local server. */
  origin: string;
  authorization: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
  /** Called with the operation right before its write request goes out (after every check has passed); it may refuse by throwing. */
  beforeWrite?: (op: Obj) => void;
}

const FIELDS = ['game_id', 'direct_id', 'asset_data', 'name', 'type', 'company', 'departments',
  'marketing_user_id', 'third_user_id', 'currency', 'price', 'price_reason', 'expect_end_date',
  'storyboard_end_date', 'storyboard_attaches', 'draft_end_date', 'draft_attaches', 'film_end_date', 'film_attaches', 'status'];
const READ_PATHS = ['/api/games', '/api/users', '/api/userinfo', '/api/user/roles', '/api/permissions', '/api/workflow/filters', '/api/workflow/directs'];
const WRITE_PATHS = ['/api/workflow/script/save', '/api/workflow/sub-script/multiple-add'];

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ClsError(message);
}
function id(value: unknown): number {
  assert(Number.isSafeInteger(value) && (value as number) > 0, 'ID 无效');
  return value as number;
}
const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** The draft ID of a save response: a positive integer, bare or as a digit string, at the top or under `script` (as the read-back has it). */
export function draftIdOf(created: any): number | undefined {
  for (const raw of [created?.id, created?.script?.id]) {
    const value = typeof raw === 'string' && /^[1-9]\d*$/.test(raw) ? Number(raw) : raw;
    if (Number.isSafeInteger(value) && value > 0) return value;
  }
  return undefined;
}

export function createClsAdapter(config: ClsAdapterConfig) {
  if (!config.origin || !config.authorization) throw new ClsError('必须使用 CLS 当前登录会话');
  const fetcher = config.fetch ?? fetch;
  const calls: Obj[] = [];
  const attempted = new Set<string>();

  async function request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<any> {
    const allowed = method === 'GET' && (READ_PATHS.includes(path) || /^\/api\/workflow\/script\/[1-9]\d*$/.test(path))
      || method === 'POST' && WRITE_PATHS.includes(path);
    assert(allowed, '发布、素材上传、删除和未知路径均被禁止');
    const start = Date.now();
    const headers: Record<string, string> = { Authorization: config.authorization };
    const init: RequestInit = { method, headers, redirect: 'error', signal: AbortSignal.timeout(config.timeoutMs ?? 30_000) };
    if (body instanceof FormData) init.body = body;
    else if (body !== undefined) { headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
    let response: Response;
    let json: Obj | null;
    try {
      response = await fetcher(`${config.origin}${path}`, init);
      json = await response.json() as Obj | null;
    } catch {
      throw new ClsError(method === 'POST' ? '写入结果未知；先回读，不重试' : 'CLS 读取失败', method === 'POST' ? 'unknown' : 'blocked');
    }
    calls.push({ method, path, http_status: response.status, business_code: json?.code, elapsed_ms: Date.now() - start });
    // A gateway or server failure after a write was sent says nothing about whether the write took effect.
    if (method === 'POST' && (response.status >= 500 || response.status === 408 || response.status === 429)) {
      throw new ClsError('写入结果未知（服务端或网关错误）；先回读，不重试', 'unknown');
    }
    assert(response.status >= 200 && response.status < 300 && json?.code === 0, 'CLS HTTP/业务码失败；停止并核对现状');
    return json!.data;
  }

  async function readCatalog(): Promise<Obj> {
    const [games, users, account, roles, permissions, filters, directions] = await Promise.all(READ_PATHS.map(path => request('GET', path)));
    assert(Array.isArray(games) && Array.isArray(users) && Array.isArray(directions) && Array.isArray(roles.roles), 'CLS 选项结构变化，停止');
    assert(account.status === 1 && Array.isArray(account.game_ids) && account.roles?.every((x: unknown) => roles.roles.includes(x)), '当前账号/角色无法核对');
    const granted = new Set<string>(roles.roles.flatMap((role: string) => permissions[role] || []));
    return {
      schema: 1, observed_at: new Date().toISOString(),
      account: { id: account.id, name: account.name, status: account.status, roles: roles.roles, game_ids: account.game_ids },
      can_create: granted.has('workflow.script.save'), can_import: granted.has('workflow.script.edit'),
      games: games.map(({ id, name, code }: Obj) => ({ id, name, code })),
      users: users.map(({ id, name, status, roles }: Obj) => ({ id, name, status, roles })),
      directions: directions.map(({ id, name, game_id }: Obj) => ({ id, name, game_id })),
      types: filters.types, currencies: filters.currencies, companies: filters.company, departments: filters.departments,
    };
  }

  async function validateOperation(op: Obj): Promise<void> {
    assert(op?.schema === 1 && ['save_draft', 'import_scripts'].includes(op.action), '只允许新建草稿及本批脚本导入');
    const { operation_id: operationId, ...unsealed } = op;
    assert(sha(new TextEncoder().encode(canonical(unsealed))) === operationId, '操作文件摘要错误');
    assert(op.payload && Object.keys(op.payload).length === FIELDS.length && FIELDS.every(k => Object.hasOwn(op.payload, k)), '草稿字段未知或缺失');
    assert(op.payload.status === -2 && !Object.hasOwn(op.payload, 'id') && op.payload.asset_data === '', '只允许创建未发布草稿，禁止更新已有需求');
    assert(['storyboard_attaches', 'draft_attaches', 'film_attaches'].every(k => Array.isArray(op.payload[k]) && op.payload[k].length === 0), '素材/附件上传不在范围内');
    assert(op.expected.names.length === op.expected.quantity && new Set(op.expected.names).size === op.expected.quantity && op.expected.quantity > 0, '脚本数量/名称不符');
    id(op.account_id); id(op.expected.creator_id); id(op.payload.game_id); id(op.payload.direct_id); id(op.payload.third_user_id);
    const current = await readCatalog();
    assert(current.account.id === op.account_id && current.can_create, '账号或建单权限变化');
    assert(current.account.game_ids.includes(op.payload.game_id) && current.games.some((g: Obj) => g.id === op.payload.game_id && g.code === 'GOFCN'), '不是获批 GOFCN 项目');
    assert(current.directions.some((d: Obj) => d.id === op.payload.direct_id && d.game_id === op.payload.game_id), '创意方向变化');
    assert(current.users.some((u: Obj) => u.id === op.payload.third_user_id && u.status === 1 && u.roles.includes('outsource'))
      && current.users.some((u: Obj) => u.id === op.expected.creator_id && u.status === 1), '供应商/创意人失效');
    if (op.action === 'import_scripts') { id(op.draft_id); assert(current.can_import, '没有脚本编辑/导入权限'); }
  }

  async function readDraft(draftId: number): Promise<Obj> {
    const data = await request('GET', `/api/workflow/script/${id(draftId)}`);
    const source = data?.script;
    assert(source && source.id === draftId && Array.isArray(source.sub_scripts), '草稿回读结构变化');
    const parent: Obj = { id: source.id, number: source.number, is_edit: source.is_edit, user_id: source.user_id, for_internal: source.for_internal };
    for (const key of FIELDS.filter(k => k !== 'asset_data')) parent[key] = source[key];
    parent.sub_scripts = source.sub_scripts.map((s: Obj) => ({
      id: s.id, script_id: s.script_id, name: s.name, data: s.data, user_id: s.user_id, tags: s.tags?.map((t: Obj) => ({ id: t.id, full_name: t.full_name })),
    }));
    return parent;
  }

  function assertParent(parent: Obj, op: Obj): void {
    assert(parent.status === -2, '需求不是未发布草稿');
    assert(parent.user_id === op.account_id && (parent.for_internal === 0 || parent.for_internal === false), '不是本账号的外包需求草稿');
    for (const key of FIELDS.filter(k => k !== 'asset_data')) {
      const value = parent[key];
      const wanted = op.payload[key];
      const equal = key === 'price'
        ? value !== null && Number.isFinite(Number(value)) && Number(value) === Number(wanted)
        : wanted === '' && value == null ? true : canonical(value) === canonical(wanted);
      assert(equal, `草稿回读字段不符：${key}`);
    }
  }

  function assertScripts(parent: Obj, op: Obj): void {
    const scripts: Obj[] = parent.sub_scripts;
    assert(scripts.length === op.expected.quantity && new Set(scripts.map(s => s.id)).size === scripts.length, '导入条数/脚本 ID 不符');
    scripts.forEach((s, i) => {
      assert(s.script_id === parent.id && s.name === op.expected.names[i] && s.user_id === op.expected.creator_id
        && s.data === (i === 0 ? op.expected.link : '同上') && s.tags?.some((t: Obj) => TAG_NAMES.includes(t.full_name)), '导入名称/归属/链接/标签不符');
    });
  }

  async function verify(op: Obj, draftId: number, start = calls.length): Promise<Obj> {
    const parent = await readDraft(draftId);
    assertParent(parent, op);
    if (op.action === 'save_draft') assert(parent.sub_scripts.length === 0, '新草稿已有脚本，停止');
    else assertScripts(parent, op);
    return { schema: 1, transport: 'cls_api', status: 'verified', action: op.action, operation_id: op.operation_id, unpublished: true, parent, calls: calls.slice(start) };
  }

  const withOperation = (error: ClsError, op: Obj): ClsError => { error.operationId = op.operation_id; return error; };
  /** A write whose failure is reported with the operation it belonged to, so it can be found again. */
  async function write(op: Obj, path: string, body: unknown): Promise<any> {
    try { config.beforeWrite?.(op); return await request('POST', path, body); } catch (error) { throw error instanceof ClsError ? withOperation(error, op) : error; }
  }

  /** What went wrong after a write was sent: the draft exists (or may), so the caller must be told which one to read back. */
  const afterWrite = (error: unknown, draftId: number, op: Obj): never => {
    if (error instanceof ClsError) { error.draftId = draftId; error.operationId = op.operation_id; }
    throw error;
  };

  async function createDraft(op: Obj): Promise<Obj> {
    assert(op.action === 'save_draft', '请求动作不符');
    await validateOperation(op);
    assert(!attempted.has(op.operation_id), '本会话已尝试此请求，不自动重试');
    attempted.add(op.operation_id);
    const start = calls.length;
    const created = await write(op, '/api/workflow/script/save', op.payload);
    // The server accepted the request but did not say which draft it made: one may exist, so this is an unknown result, not a refusal.
    const draftId = draftIdOf(created);
    if (draftId === undefined) throw withOperation(new ClsError('创建响应没有草稿 ID；草稿可能已创建，先回读核对，不重试', 'unknown'), op);
    try {
      const status = created?.status ?? created?.script?.status; // the read-back below is the real check; this only stops on a plain contradiction
      assert(status === undefined || status === -2, '创建结果不是草稿，停止');
      return await verify(op, draftId, start);
    } catch (error) { return afterWrite(error, draftId, op); }
  }

  async function importScripts(op: Obj): Promise<Obj> {
    assert(op.action === 'import_scripts', '请求动作不符');
    await validateOperation(op);
    const start = calls.length;
    const parent = await readDraft(op.draft_id);
    assertParent(parent, op);
    assert(parent.is_edit === true || parent.is_edit === 1, '当前草稿不可编辑');
    assert(parent.sub_scripts.length === 0, '草稿已有脚本；先核对，不导入');
    assert(!attempted.has(op.operation_id), '本会话已尝试此导入，不自动重试');
    assert(typeof op.csv?.filename === 'string' && /^[^/\\\r\n]+\.csv$/i.test(op.csv.filename), '只允许本批 CSV 脚本文件');
    const bytes = Buffer.from(op.csv.base64, 'base64');
    assert(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf && sha(bytes) === op.csv.sha256, 'CSV 编码/摘要错误');
    const rows = parseCsv(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(3)));
    const expected = [CSV_HEADERS, ...op.expected.names.map((n: string, i: number) => [n, i === 0 ? op.expected.link : '同上', TAG_NAMES[0]])];
    assert(canonical(rows) === canonical(expected), 'CSV 与获批需求不一致');
    const form = new FormData();
    form.append('script_id', String(op.draft_id));
    form.append('file', new File([bytes], op.csv.filename, { type: 'text/csv' }));
    form.append('user_id', String(op.expected.creator_id));
    attempted.add(op.operation_id);
    await write(op, '/api/workflow/sub-script/multiple-add', form);
    try { return await verify(op, op.draft_id, start); } catch (error) { return afterWrite(error, op.draft_id, op); }
  }

  return Object.freeze({ readCatalog, readDraft, createDraft, importScripts, verify });
}

export type ClsAdapter = ReturnType<typeof createClsAdapter>;
