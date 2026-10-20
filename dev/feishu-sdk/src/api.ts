import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { BridgeError } from './errors.ts';
import { lark } from './client.ts';
import type { FeishuAuth } from './auth.ts';

const TOKEN = /^[A-Za-z0-9]{8,64}$/;
const SHEET_ID = /^[A-Za-z0-9_-]{1,64}$/;
const A1 = /^[A-Za-z]{1,3}[0-9]{1,7}(:[A-Za-z]{1,3}[0-9]{1,7})?$/;
const OCCUPIED = /non[- ]?empty|occupied|cannot overwrite|not allowed to overwrite|already (has|contains)|非空|已有内容|不为空|禁止覆盖/i;
/** Feishu codes: the user token is invalid or expired (a renewal may fix it), and the permission is missing. */
const TOKEN_REJECTED = new Set([99991668, 99991677]);
const SCOPE_MISSING = new Set([99991679, 99991672]);
const MAX_WRITES = 100;

/** The only read endpoints the workflow uses. Anything else is refused before it is sent. */
const READ_ALLOWLIST: readonly RegExp[] = [
  /^\/open-apis\/wiki\/v2\/spaces\/get_node$/,
  /^\/open-apis\/sheets\/v3\/spreadsheets\/[A-Za-z0-9]+\/sheets\/query$/,
  /^\/open-apis\/sheets\/v2\/spreadsheets\/[A-Za-z0-9]+\/(dataValidation|values_batch_get|metainfo)$/,
  /^\/open-apis\/docx\/v1\/documents\/[A-Za-z0-9]+\/raw_content$/,
];

export interface CellWrite {
  sheet_id: string;
  range: string;
  cells: unknown[][];
  allow_overwrite: false;
}

interface Call {
  method: 'GET' | 'POST';
  url: string;
  params?: Record<string, string | number | boolean>;
  data?: unknown;
  stream?: boolean;
  /** A write is never retried and a failure without an answer is reported as an unknown result. */
  write?: boolean;
}

export class FeishuApi {
  readonly auth: FeishuAuth;
  private sleep: (ms: number) => Promise<void>;

  constructor(auth: FeishuAuth, sleep: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms))) {
    this.auth = auth;
    this.sleep = sleep;
  }

  private async send(call: Call, again = true): Promise<any> {
    const token = await this.auth.accessToken();
    let result: any;
    try {
      const payload: Record<string, unknown> = { method: call.method, url: call.url };
      if (call.params) payload.params = call.params;
      if (call.data !== undefined) payload.data = call.data;
      if (call.stream) payload.responseType = 'stream';
      result = await this.auth.client.request(payload as any, lark.withUserAccessToken(token));
    } catch (e: any) {
      if (e?.response) {
        const body = e.response.data;
        // A stream body of an error response is not read: the status says enough.
        const parsed = body && typeof body === 'object' && !('pipe' in body) ? body : {};
        return this.failure(call, parsed, e.response.status, again);
      }
      throw new BridgeError(call.write ? 'unknown_result' : 'network',
        call.write ? '飞书写入请求没有收到结果，写入可能已生效；必须回读核对，不可重发' : '无法连接飞书');
    }
    if (call.stream) return result;
    if (result && typeof result === 'object' && typeof result.code === 'number' && result.code !== 0) return this.failure(call, result, 200, again);
    return result && typeof result === 'object' && 'data' in result ? result.data : result;
  }

  private async failure(call: Call, body: any, status: number, again: boolean): Promise<any> {
    const code = typeof body?.code === 'number' ? body.code : undefined;
    const message = String(body?.msg ?? body?.message ?? body?.error_description ?? `HTTP ${status}`);
    if (code !== undefined && TOKEN_REJECTED.has(code)) {
      if (again && !call.write) {
        await this.auth.refresh(true);
        return this.send(call, false);
      }
      throw new BridgeError('auth_required', '飞书登录已失效，请重新授权', code);
    }
    if (code !== undefined && SCOPE_MISSING.has(code)) throw new BridgeError('scope_missing', `飞书登录缺少调用所需的权限；请在应用后台开通并重新授权（${message}）`, code);
    if (call.write && OCCUPIED.test(message)) throw new BridgeError('occupied', '服务端拒绝写入非空目标', code);
    if (call.write && status >= 500) throw new BridgeError('unknown_result', `飞书写入返回 ${status}，写入可能已生效；必须回读核对，不可重发`, code);
    throw new BridgeError('api', `飞书接口返回错误：${message}`, code);
  }

  /**
   * Asks Feishu who the stored login belongs to. It is a real call with the user's token, so a login that has lapsed, been revoked or
   * been used up shows up here (after one renewal attempt) instead of in the middle of a write; the renewal also keeps an idle login alive.
   */
  async verifyUser(): Promise<{ open_id: string; name?: string }> {
    const data = await this.send({ method: 'GET', url: '/open-apis/authen/v1/user_info' });
    const openId = typeof data?.open_id === 'string' ? data.open_id : '';
    if (!openId) throw new BridgeError('api', '无法确认当前登录的飞书账号');
    return { open_id: openId, ...(typeof data?.name === 'string' && data.name ? { name: data.name } : {}) };
  }

  /** A read-only call to one of the endpoints the workflow uses. */
  async get(urlPath: string, params?: Record<string, unknown>): Promise<any> {
    if (typeof urlPath !== 'string' || urlPath.includes('..') || urlPath.includes('?') || !urlPath.startsWith('/open-apis/')
      || !READ_ALLOWLIST.some(pattern => pattern.test(urlPath))) {
      throw new BridgeError('invalid_request', '未许可的飞书读取路径');
    }
    const query: Record<string, string | number | boolean> = {};
    for (const [key, value] of Object.entries(params ?? {})) {
      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') throw new BridgeError('invalid_request', `参数 ${key} 类型不支持`);
      query[key] = value;
    }
    return this.send({ method: 'GET', url: urlPath, params: query });
  }

  /** The workbook version. The same endpoint is read before and after, so only the change matters, not what the number means. */
  async revision(token: string): Promise<number> {
    this.checkToken(token);
    const data = await this.send({ method: 'GET', url: `/open-apis/sheets/v2/spreadsheets/${token}/metainfo` });
    const value = data?.properties?.revision;
    if (!Number.isSafeInteger(value) || value < 0) throw new BridgeError('api', '无法读取文档版本');
    return value;
  }

  /** Exports the whole workbook as a new XLSX file; an existing file is never replaced. */
  async exportXlsx(token: string, output: string): Promise<{ path: string; bytes: number }> {
    this.checkToken(token);
    if (!path.isAbsolute(output) || !output.toLowerCase().endsWith('.xlsx')) throw new BridgeError('invalid_request', '导出路径必须是绝对路径的 .xlsx 文件');
    if (await fs.stat(output).then(() => true, () => false)) throw new BridgeError('invalid_request', '导出目标文件已存在，不会覆盖');
    await fs.mkdir(path.dirname(output), { recursive: true });

    const created = await this.send({ method: 'POST', url: '/open-apis/drive/v1/export_tasks', data: { file_extension: 'xlsx', token, type: 'sheet' } });
    const ticket = created?.ticket;
    if (typeof ticket !== 'string' || !ticket) throw new BridgeError('api', '导出任务没有返回编号');
    let fileToken = '';
    for (let attempt = 0; attempt < 40 && !fileToken; attempt++) {
      if (attempt) await this.sleep(Math.min(3000, 500 + attempt * 250));
      const polled = await this.send({ method: 'GET', url: `/open-apis/drive/v1/export_tasks/${encodeURIComponent(ticket)}`, params: { token } });
      const job = polled?.result;
      if (job?.job_status === 0 && typeof job.file_token === 'string') fileToken = job.file_token;
      else if (job && job.job_status !== 1 && job.job_status !== 2) throw new BridgeError('api', `导出失败：${job.job_error_msg ?? job.job_status}`);
    }
    if (!fileToken) throw new BridgeError('api', `导出任务仍未完成（ticket=${ticket}）；稍后只读查询该任务，不要重新提交`);

    const stream = await this.send({ method: 'GET', url: `/open-apis/drive/v1/export_tasks/file/${encodeURIComponent(fileToken)}/download`, stream: true }) as Readable;
    try {
      await pipeline(stream, createWriteStream(output, { flags: 'wx' }));
      const size = (await fs.stat(output)).size;
      const head = Buffer.alloc(2);
      const handle = await fs.open(output, 'r');
      try { await handle.read(head, 0, 2, 0); } finally { await handle.close(); }
      if (size < 22 || head.toString('latin1') !== 'PK') throw new BridgeError('api', '导出的文件不是有效的 XLSX');
      return { path: output, bytes: size };
    } catch (e) {
      // EEXIST: another run made this file in the meantime; it is not ours to delete.
      if ((e as NodeJS.ErrnoException)?.code !== 'EEXIST') await fs.rm(output, { force: true });
      throw e;
    }
  }

  /**
   * Writes cell ranges without ever overwriting: the server is told allow_overwrite=false for every range and refuses when a
   * target cell is not empty. Same request as `lark-cli sheets +cells-set --allow-overwrite=false` (captured with its --dry-run).
   */
  async cellsSet(token: string, writes: CellWrite[]): Promise<any> {
    this.checkToken(token);
    if (!Array.isArray(writes) || writes.length < 1 || writes.length > MAX_WRITES) throw new BridgeError('invalid_request', `写入范围数必须在 1 到 ${MAX_WRITES} 之间`);
    const operations = writes.map(write => {
      if (write?.allow_overwrite !== false) throw new BridgeError('invalid_request', '缺少不可覆盖保护（allow_overwrite 必须为 false）');
      if (!SHEET_ID.test(write.sheet_id ?? '') || !A1.test(write.range ?? '')) throw new BridgeError('invalid_request', '写入范围格式无效');
      if (!Array.isArray(write.cells) || !write.cells.length || !write.cells.every(row => Array.isArray(row) && row.length)) throw new BridgeError('invalid_request', '写入内容必须是二维数组');
      return { input: { allow_overwrite: false, cells: write.cells, excel_id: token, range: write.range, sheet_id: write.sheet_id }, tool_name: 'set_cell_range' };
    });
    return this.send({
      method: 'POST', write: true, url: `/open-apis/sheet_ai/v2/spreadsheets/${token}/tools/invoke_write`,
      data: { input: JSON.stringify({ excel_id: token, operations }), tool_name: 'batch_update' },
    });
  }

  /** Creates a new, empty workbook. Only the isolated safety probe uses it. */
  async createWorkbook(title: string): Promise<{ spreadsheet_token: string; url?: string }> {
    if (typeof title !== 'string' || !title.trim() || title.length > 200) throw new BridgeError('invalid_request', '表格标题无效');
    const data = await this.send({ method: 'POST', write: true, url: '/open-apis/sheets/v3/spreadsheets', data: { title } });
    const sheet = data?.spreadsheet;
    if (typeof sheet?.spreadsheet_token !== 'string') throw new BridgeError('unknown_result', '新建表格的结果无法确认，不要重复创建');
    return { spreadsheet_token: sheet.spreadsheet_token, ...(sheet.url ? { url: sheet.url } : {}) };
  }

  private checkToken(token: string) {
    if (typeof token !== 'string' || !TOKEN.test(token)) throw new BridgeError('invalid_request', '表格 token 格式无效');
  }
}

