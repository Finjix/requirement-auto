import fs from 'node:fs';
import { ClsError } from './cls-adapter.ts';

/*
 * The CLS client of the material upload, kept apart from the requirement client (cls-adapter.ts, which can never upload). It speaks the
 * same internal HTTP API the page 我的创意 > 创意列表 > 上传创意 uses, with the logged-in session's Authorization, and can do exactly what
 * that page does: read the options, ask for upload links, put the files into the storage those links name, create the creatives from
 * them and save their annotation (创意人, 制作人, 素材类型). Deleting, publishing, confirming, editing tags or anything else has no
 * method and no allowed path. Creating is never retried: what a create did is found out by reading back.
 */

type Obj = Record<string, any>;

/** The page's 上传创意 calls, in the order it makes them (see the CLS frontend: views/creativity/materials-upload, components/MaterialUpload). */
const READ_PATHS = ['/api/creative/games', '/api/userinfo', '/api/permissions', '/api/game/adsdesk/dirs', '/api/game/recommend-filters',
  '/api/material/filters', '/api/creatives'];
const SIGN = '/api/qcloud/signed-url';
const CREATE = '/api/creative/multiple-upload';
const ANNOTATE = '/api/creative/multiple-edit';
const LOG = '/api/report/log';
const WRITE_PATHS = [SIGN, CREATE, ANNOTATE, LOG];

/** Where an upload link may point: Tencent COS over https, as the links CLS hands out do. */
export const COS_HOST = /^[a-z0-9-]+\.cos\.[a-z0-9-]+\.myqcloud\.com$/;

/**
 * The Content-Type the page sends with each file. The page puts the file with axios 0.19, whose default for PUT is form-urlencoded
 * and which keeps it for a File body; the storage link only signs the host, so this is about matching what CLS gets from the page.
 */
export const PAGE_PUT_TYPE = 'application/x-www-form-urlencoded';

export interface CreativeAdapterConfig {
  /** https://creative.centurygames.cn in production; tests use a local server. */
  origin: string;
  authorization: string;
  timeoutMs?: number;
  /** Creating many creatives takes the server a while: the page waits up to 10 minutes. */
  createTimeoutMs?: number;
  /** A file goes up in one request; big videos need long. */
  uploadTimeoutMs?: number;
  fetch?: typeof fetch;
  /** Hosts an upload link may point at; tests use a local server. */
  uploadHost?: RegExp;
  allowHttpUpload?: boolean;
  /** Called right before a create or an annotation goes out (after every check has passed); it may refuse by throwing. */
  beforeWrite?: (path: string) => void;
}

export interface SignedFile { key: string; url: string; object: string; expires_at: number | undefined }

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ClsError(message);
}

/** When the storage signature of a link runs out (seconds since 1970), from its q-sign-time / q-key-time; undefined when it does not say. */
export function signatureEnd(url: string): number | undefined {
  try {
    const u = new URL(url);
    const sign = u.searchParams.get('sign');
    const params = sign ? new URLSearchParams(sign) : u.searchParams;
    const time = params.get('q-sign-time') ?? params.get('q-key-time');
    const end = Number(time?.split(';')[1]);
    return Number.isSafeInteger(end) && end > 0 ? end : undefined;
  } catch { return undefined; }
}

export function createCreativeAdapter(config: CreativeAdapterConfig) {
  if (!config.origin || !config.authorization) throw new ClsError('必须使用 CLS 当前登录会话');
  const fetcher = config.fetch ?? fetch;
  const uploadHost = config.uploadHost ?? COS_HOST;
  const calls: Obj[] = [];
  /** The upload links CLS gave this process: only these are ever put to. */
  const signed = new Map<string, string>();

  async function request(method: 'GET' | 'POST', path: string, query?: URLSearchParams, body?: unknown, timeoutMs?: number): Promise<any> {
    const allowed = method === 'GET' && (READ_PATHS.includes(path) || /^\/api\/creative\/[1-9]\d*$/.test(path)) || method === 'POST' && WRITE_PATHS.includes(path);
    assert(allowed, '删除、发布、确认和未知路径均被禁止');
    const write = method === 'POST' && (path === CREATE || path === ANNOTATE);
    const start = Date.now();
    const headers: Record<string, string> = { Authorization: config.authorization };
    const init: RequestInit = { method, headers, redirect: 'error', signal: AbortSignal.timeout(timeoutMs ?? config.timeoutMs ?? 30_000) };
    if (body !== undefined) { headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
    const url = `${config.origin}${path}${query && [...query].length ? `?${query}` : ''}`;
    // Before the request and outside the try: a refusal here means nothing was sent.
    if (write) config.beforeWrite?.(path);
    let response: Response;
    let json: Obj | null = null;
    try {
      response = await fetcher(url, init);
    } catch (error) {
      const reason = (error as Error)?.name === 'TimeoutError' ? '请求超时' : '连接失败';
      throw new ClsError(write ? `写入结果未知（${reason}）；先回读，不重试` : `CLS 请求失败（${reason}）`, write ? 'unknown' : 'blocked');
    }
    try { json = await response.json() as Obj | null; } catch { /* a body that is not JSON: the status below still says what happened */ }
    calls.push({ method, path, http_status: response.status, business_code: json?.code, elapsed_ms: Date.now() - start });
    const serverMessage = [json?.message, json?.msg].find((x) => typeof x === 'string' && x.trim());
    const detail = `HTTP ${response.status}${json?.code !== undefined ? `，业务码 ${json.code}` : ''}${serverMessage ? `，${String(serverMessage).trim().slice(0, 300)}` : ''}`;
    if (write && (response.status >= 500 || response.status === 408 || response.status === 429)) {
      throw new ClsError(`写入结果未知（服务端或网关错误，${detail}）；先回读，不重试`, 'unknown');
    }
    if (write && response.status >= 200 && response.status < 300 && typeof json?.code !== 'number') {
      throw new ClsError(`写入结果未知（${detail}，响应没有业务码）；先回读，不重试`, 'unknown');
    }
    assert(response.status >= 200 && response.status < 300 && json?.code === 0, `CLS 请求失败（${detail}）`);
    return json!.data;
  }

  const get = (path: string, params: Record<string, string | number | (string | number)[]> = {}) => {
    const query = new URLSearchParams();
    // Lists go the way the page's axios sends them: key[]=a&key[]=b.
    for (const [key, value] of Object.entries(params)) {
      if (Array.isArray(value)) for (const item of value) query.append(`${key}[]`, String(item));
      else query.append(key, String(value));
    }
    return request('GET', path, query);
  };

  async function sign(gameId: number, keys: string[]): Promise<{ files: SignedFile[]; mapping: Record<string, string> }> {
    assert(keys.length > 0 && new Set(keys).size === keys.length, '上传文件名为空或重复');
    const data = await request('POST', SIGN, undefined, { files: keys, game_id: gameId });
    const urls = data?.urls;
    const mapping = data?.mapping ?? {};
    assert(urls && typeof urls === 'object' && !Array.isArray(urls) && typeof mapping === 'object', 'CLS 上传链接返回结构变化，停止');
    const files: SignedFile[] = [];
    for (const [key, raw] of Object.entries(urls)) {
      assert(keys.includes(key) && typeof raw === 'string', 'CLS 返回了未申请文件的上传链接，停止');
      let url: URL;
      try { url = new URL(raw); } catch { throw new ClsError('CLS 返回的上传链接无效，停止'); }
      assert((url.protocol === 'https:' || config.allowHttpUpload && url.protocol === 'http:') && uploadHost.test(url.hostname) && !url.username && !url.password,
        `CLS 返回的上传地址不是对象存储（${url.hostname}），停止`);
      assert(typeof mapping[key] === 'string' && mapping[key].endsWith(`/${key.slice(key.indexOf('/') + 1)}`), 'CLS 上传文件名映射缺失或不符，停止');
      signed.set(key, raw);
      files.push({ key, url: raw, object: `${url.host}${decodeURIComponent(url.pathname)}`, expires_at: signatureEnd(raw) });
    }
    return { files, mapping: Object.fromEntries(Object.entries(mapping).map(([k, v]) => [k, String(v)])) };
  }

  /** Puts one file to the link CLS gave for it. No CLS credentials go with it: the link carries its own signature. */
  async function put(key: string, file: string, size: number): Promise<Obj> {
    const url = signed.get(key);
    assert(url, '没有这个文件的上传链接');
    const blob = await fs.openAsBlob(file);
    assert(blob.size === size, `文件大小变化：${file}`);
    const start = Date.now();
    let response: Response;
    try {
      response = await fetcher(url, { method: 'PUT', body: blob, headers: { 'Content-Type': PAGE_PUT_TYPE }, redirect: 'error', signal: AbortSignal.timeout(config.uploadTimeoutMs ?? 60 * 60_000) });
    } catch (error) {
      throw new ClsError(`文件上传失败（${(error as Error)?.name === 'TimeoutError' ? '超时' : '连接失败'}）：${file}`);
    }
    await response.arrayBuffer().catch(() => undefined);
    calls.push({ method: 'PUT', path: '<upload link>', http_status: response.status, elapsed_ms: Date.now() - start });
    assert(response.status >= 200 && response.status < 300, `文件上传失败（HTTP ${response.status}）：${file}`);
    return { etag: response.headers.get('etag')?.replace(/"/g, '') ?? null, bytes: size };
  }

  /** The page writes these two lines to the CLS log around an upload; failing to log never stops the upload. */
  async function log(message: string): Promise<void> {
    try { await request('POST', LOG, undefined, { msg: message }); } catch { /* best effort, as on the page */ }
  }

  async function createCreatives(gameId: number, names: string[], directories: Record<string, number>): Promise<{ succ: { name: string; id: number }[]; fail: string[] }> {
    assert(names.length > 0 && new Set(names).size === names.length && names.every(n => Number.isSafeInteger(directories[n]) && directories[n]! > 0), '创意名称/上传目录不完整');
    const query = new URLSearchParams({ confirmed: '1' });
    const data = await request('POST', CREATE, query, { game_id: gameId, names, adsdesk_dir_ids: directories }, config.createTimeoutMs ?? 10 * 60_000);
    const succ = data?.succ;
    const fail = data?.fail ?? [];
    const ok = Array.isArray(succ) && Array.isArray(fail)
      && succ.every((s: Obj) => typeof s?.name === 'string' && names.includes(s.name) && Number.isSafeInteger(s.id) && s.id > 0)
      && fail.every((f: unknown) => typeof f === 'string');
    if (!ok) throw new ClsError('创建结果结构不符；创意可能已创建，先回读核对，不重试', 'unknown');
    return { succ: succ.map((s: Obj) => ({ name: s.name, id: s.id })), fail: fail.map(String) };
  }

  async function annotate(gameId: number, creatives: { id: number; sponsor: number; producers: number[]; types: string[] }[]): Promise<void> {
    assert(creatives.length > 0 && creatives.every(c => Number.isSafeInteger(c.id) && c.id > 0 && Number.isSafeInteger(c.sponsor) && c.sponsor > 0
      && c.producers.length > 0 && c.producers.every(p => Number.isSafeInteger(p) && p > 0) && c.types.length > 0), '标注不完整');
    // The page's 保存 sends exactly these fields; custom_tags (创意标签) stays empty.
    await request('POST', ANNOTATE, undefined, { game_id: gameId, creatives: creatives.map(c => ({ id: c.id, sponsor: c.sponsor, producers: c.producers, types: c.types, custom_tags: [] })) });
  }

  return Object.freeze({
    games: () => get('/api/creative/games'),
    account: () => get('/api/userinfo'),
    permissions: () => get('/api/permissions'),
    directories: (gameId: number) => get('/api/game/adsdesk/dirs', { id: gameId }),
    people: (gameId: number) => get('/api/game/recommend-filters', { id: gameId }),
    types: (gameId: number) => get('/api/material/filters', { confirmed: 1, fields: 'types', game_id: gameId }),
    /** Creatives of the game whose name or ID contains the text (confirmed ones, or the 待确认 ones). */
    search: (gameId: number, text: string, confirmed = true) => get('/api/creatives', {
      page: 1, page_size: 50, game_id: gameId, keywords: text, keyword_type: 'creative', ...(confirmed ? {} : { confirmed: 0 }),
    }),
    /** The newest creatives this user uploaded, as the list shows them. */
    mine: (gameId: number, userId: number, pageSize = 50) => get('/api/creatives', {
      page: 1, page_size: pageSize, game_id: gameId, upload_users: [userId], sort_field: 'updated_at', sort_order: 'desc',
    }),
    creative: (id: number) => {
      assert(Number.isSafeInteger(id) && id > 0, '创意 ID 无效');
      return request('GET', `/api/creative/${id}`);
    },
    sign, put, log, createCreatives, annotate,
    calls: () => calls.slice(),
  });
}

export type CreativeAdapter = ReturnType<typeof createCreativeAdapter>;
