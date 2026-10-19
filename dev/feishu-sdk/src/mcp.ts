import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { FeishuAuth, type AuthStatus } from './auth.ts';
import { loadApp, REQUIRED_SCOPES, type Endpoints } from './config.ts';
import { toPayload } from './errors.ts';
import { expectedOpenId, resolveDataPaths } from './paths.ts';

export const SERVER_NAME = 'feishu-auth';
export const TOOL_NAMES = ['feishu_auth_status', 'feishu_auth_login', 'feishu_auth_poll', 'feishu_auth_logout'] as const;

const INSTRUCTIONS = [
  '飞书用户登录。登录属于当前对话的用户本人：工具不接受任何用户标识参数，令牌只保存在本进程所服务用户的目录里，不会出现在工具结果中。',
  '流程：feishu_auth_status 查看是否已登录 → 未登录则 feishu_auth_login 取得授权链接和验证码 → 把链接和验证码原样发给用户，请用户在自己的浏览器打开并确认，然后结束本轮等待用户回复 → 用户回复已授权后调用 feishu_auth_poll。',
  '不要改写、缩短或猜测授权链接；不要替用户点击或登录；不要索要用户的飞书密码。',
].join('\n');

export interface ServerContext {
  env?: NodeJS.ProcessEnv;
  endpoints?: Endpoints;
}

type ToolResult = { content: { type: 'text'; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };

const ok = (text: string, data: Record<string, unknown>): ToolResult => ({ content: [{ type: 'text', text }], structuredContent: data });

function when(ms: number | undefined): string {
  return ms ? new Date(ms).toLocaleString('zh-CN', { hour12: false }) : '未知';
}

function summary(status: AuthStatus): string {
  if (!status.app_configured) return '飞书应用凭证未配置（FEISHU_APP_ID / FEISHU_APP_SECRET），无法登录；请联系管理员。';
  const lines: string[] = [];
  if (status.logged_in) {
    lines.push(`已登录飞书：${status.name ?? '（未取得姓名）'}（${status.open_id}）`);
    lines.push(status.refreshable ? `登录有效至 ${when(status.refresh_expires_at)}，到期前会自动续期。` : `这次登录无法续期，约在 ${when(status.access_expires_at)} 失效。`);
    lines.push(status.missing_scopes?.length ? `缺少权限：${status.missing_scopes.join('、')}，需要重新授权。` : '本流程所需权限齐全。');
  } else {
    lines.push('尚未登录飞书。');
  }
  if (status.pending_login) lines.push(`有一次授权尚未完成（验证码 ${status.pending_login.user_code}，${when(status.pending_login.expires_at)} 前有效）。`);
  return lines.join('\n');
}

export function createServer(context: ServerContext = {}): McpServer {
  const env = context.env ?? process.env;
  let auth: FeishuAuth | undefined;
  // Built on first use, so a configuration problem is reported by the tool that hits it instead of stopping the server.
  const current = (): FeishuAuth => {
    if (!auth) {
      const paths = resolveDataPaths(env);
      let app, missingApp;
      try { app = loadApp(env, paths); } catch (e) { missingApp = (e as Error).message; /* status still works without it */ }
      auth = new FeishuAuth({ paths, app, missingApp, expectedOpenId: expectedOpenId(env), ...(context.endpoints ? { endpoints: context.endpoints } : {}) });
    }
    return auth;
  };
  const guard = async (body: (auth: FeishuAuth) => Promise<ToolResult>): Promise<ToolResult> => {
    try { return await body(current()); } catch (error) {
      const payload = toPayload(error, await auth?.secrets().catch(() => []) ?? []);
      return { content: [{ type: 'text', text: `失败（${payload.kind}）：${payload.message}` }], structuredContent: { ok: false, error: payload }, isError: true };
    }
  };

  const server = new McpServer({ name: SERVER_NAME, version: '1.0.0' }, { instructions: INSTRUCTIONS });

  server.registerTool('feishu_auth_status', {
    title: '飞书登录状态',
    description: '查看当前用户是否已登录飞书、授权了哪些权限、登录何时到期。只读，不联网，不返回令牌。',
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, () => guard(async a => {
    const status = await a.status(REQUIRED_SCOPES);
    return ok(summary(status), { ...status });
  }));

  server.registerTool('feishu_auth_login', {
    title: '发起飞书授权',
    description: '为当前用户发起飞书设备授权，返回授权链接和验证码。把它们原样发给用户，让用户在自己的浏览器里打开并确认；确认后再调用 feishu_auth_poll。已有未过期的授权请求时返回同一个。',
    inputSchema: { force: z.boolean().optional().describe('已登录且权限齐全时默认不重复授权；传 true 强制重新授权（例如要换账号）') },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, ({ force }) => guard(async a => {
    const status = await a.status(REQUIRED_SCOPES);
    if (status.logged_in && !status.missing_scopes?.length && !force) {
      return ok(`${summary(status)}\n无需重新授权。`, { ...status, already_logged_in: true });
    }
    const prompt = await a.startLogin();
    const minutes = Math.max(1, Math.round(prompt.expires_in_s / 60));
    return ok([
      '请把下面的内容原样发给用户（链接不要改写或缩短），请用户在自己的浏览器打开链接并点击确认授权：',
      `授权链接：${prompt.verification_uri_complete}`,
      `验证码：${prompt.user_code}（如页面要求输入）`,
      `有效期约 ${minutes} 分钟。`,
      '发完后结束本轮，等用户回复已授权，再调用 feishu_auth_poll。',
    ].join('\n'), { ...prompt });
  }));

  server.registerTool('feishu_auth_poll', {
    title: '确认飞书授权结果',
    description: '用户确认授权后调用，最多等待 wait_seconds 秒，授权完成时保存登录。返回 authorized / pending / denied / expired。',
    inputSchema: { wait_seconds: z.number().int().min(0).max(50).optional().describe('最长等待秒数，默认 40，最大 50') },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, ({ wait_seconds }) => guard(async a => {
    const result = await a.pollLogin((wait_seconds ?? 40) * 1000);
    switch (result.state) {
      case 'authorized':
        return ok(`授权完成：${result.name ?? ''}（${result.open_id}）。${result.refreshable ? '' : '注意：这次没有取得续期凭据，登录约两小时后失效。'}`.trim(), { ...result });
      case 'pending':
        return ok(`用户还没有确认授权。请提醒用户打开授权链接并点击确认，${result.retry_after_s} 秒后可再次调用本工具（授权还剩约 ${Math.round(result.expires_in_s / 60)} 分钟有效）。`, { ...result });
      case 'denied':
        return ok('用户拒绝了授权。不要重试；询问用户是否要重新发起授权。', { ...result });
      case 'expired':
        return ok('授权已过期。需要重新调用 feishu_auth_login 发起授权。', { ...result });
    }
  }));

  server.registerTool('feishu_auth_logout', {
    title: '退出飞书登录',
    description: '删除当前用户在本机保存的飞书登录。用户明确要求退出或要换账号时才调用。',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, () => guard(async a => {
    await a.logout();
    return ok('已退出飞书登录，本机不再保存该用户的登录信息。', { logged_in: false });
  }));

  return server;
}

