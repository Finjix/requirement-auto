import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { FeishuAuth, type AuthStatus } from './auth.ts';
import { loadApp, REQUIRED_SCOPES, type Endpoints } from './config.ts';
import { toPayload } from './errors.ts';
import { expectedOpenId, resolveDataPaths } from './paths.ts';

export const SERVER_NAME = 'feishu-auth';
export const TOOL_NAMES = ['feishu_auth_status', 'feishu_auth_login', 'feishu_auth_poll', 'feishu_auth_logout'] as const;

const INSTRUCTIONS = [
  'Feishu user login. The login belongs to the user of the current conversation: no tool takes a user identifier, and tokens stay in the directory of the user this process serves and never appear in results.',
  'Flow: feishu_auth_status to see if logged in -> if not, feishu_auth_login for an authorization link and code -> send both to the user verbatim, ask them to open the link in their own browser and confirm, then end the turn and wait for their reply -> after they reply, feishu_auth_poll.',
  'Never rewrite, shorten or guess the link; never click or log in for the user; never ask for their Feishu password.',
].join('\n');

export interface ServerContext {
  env?: NodeJS.ProcessEnv;
  endpoints?: Endpoints;
}

type ToolResult = { content: { type: 'text'; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };

const ok = (text: string, data: Record<string, unknown>): ToolResult => ({ content: [{ type: 'text', text }], structuredContent: data });

function when(ms: number | undefined): string {
  return ms ? new Date(ms).toLocaleString('zh-CN', { hour12: false }) : 'unknown';
}

function summary(status: AuthStatus): string {
  if (!status.app_configured) return 'The Feishu app credentials are not configured (FEISHU_APP_ID / FEISHU_APP_SECRET), so login is impossible. Tell the user to contact an admin.';
  const lines: string[] = [];
  if (status.logged_in) {
    lines.push(`Logged in to Feishu: ${status.name ?? '(name unknown)'} (${status.open_id})`);
    lines.push(status.refreshable ? `Login valid until ${when(status.refresh_expires_at)}; renewed automatically before then.` : `This login cannot be renewed and expires around ${when(status.access_expires_at)}.`);
    lines.push(status.missing_scopes?.length ? `Missing scopes: ${status.missing_scopes.join(', ')}; the user must authorize again.` : 'All scopes this flow needs are granted.');
  } else {
    lines.push('Not logged in to Feishu.');
  }
  if (status.pending_login) lines.push(`An authorization is pending (code ${status.pending_login.user_code}, valid until ${when(status.pending_login.expires_at)}).`);
  return lines.join('\n');
}

export function createServer(context: ServerContext = {}): McpServer {
  const env = context.env ?? process.env;
  let auth: FeishuAuth | undefined;
  let withoutApp = false;
  // Built on first use, so a configuration problem is reported by the tool that hits it instead of stopping the server.
  // One built without the app credentials is not kept: once they are written (app.json) the next call picks them up.
  const current = (): FeishuAuth => {
    if (!auth || withoutApp) {
      const paths = resolveDataPaths(env);
      let app, missingApp;
      try { app = loadApp(env, paths); } catch (e) { missingApp = (e as Error).message; /* status still works without it */ }
      withoutApp = missingApp !== undefined;
      auth = new FeishuAuth({ paths, app, missingApp, expectedOpenId: expectedOpenId(env), ...(context.endpoints ? { endpoints: context.endpoints } : {}) });
    }
    return auth;
  };
  const guard = async (body: (auth: FeishuAuth) => Promise<ToolResult>): Promise<ToolResult> => {
    try { return await body(current()); } catch (error) {
      const payload = toPayload(error, await auth?.secrets().catch(() => []) ?? []);
      return { content: [{ type: 'text', text: `Failed (${payload.kind}): ${payload.message}` }], structuredContent: { ok: false, error: payload }, isError: true };
    }
  };

  const server = new McpServer({ name: SERVER_NAME, version: '1.0.0' }, { instructions: INSTRUCTIONS });

  server.registerTool('feishu_auth_status', {
    title: 'Feishu login status',
    description: 'Show from the local record whether the current user is logged in to Feishu, which scopes were granted and when the login expires. Reads only the local record, no network and no check with Feishu, so it cannot tell whether the login still works (use `gof.mjs login check` for that). Returns no token.',
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, () => guard(async a => {
    const status = await a.status(REQUIRED_SCOPES);
    return ok(summary(status), { ...status });
  }));

  server.registerTool('feishu_auth_login', {
    title: 'Start Feishu authorization',
    description: 'Start a Feishu device authorization for the current user and return the authorization link and code. Send both to the user verbatim, have them open the link in their own browser and confirm, then call feishu_auth_poll. Returns the same request while an unexpired one exists.',
    inputSchema: { force: z.boolean().optional().describe('By default no new authorization starts when already logged in with all scopes; pass true to force one (e.g. to switch accounts)') },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, ({ force }) => guard(async a => {
    const status = await a.status(REQUIRED_SCOPES);
    if (status.logged_in && !status.missing_scopes?.length && !force) {
      return ok(`${summary(status)}\nNo new authorization needed.`, { ...status, already_logged_in: true });
    }
    const prompt = await a.startLogin();
    const minutes = Math.max(1, Math.round(prompt.expires_in_s / 60));
    return ok([
      'Send the following to the user verbatim (do not rewrite or shorten the link) and ask them to open it in their own browser and confirm the authorization:',
      `Authorization link: ${prompt.verification_uri_complete}`,
      `Code: ${prompt.user_code} (if the page asks for it)`,
      `Valid for about ${minutes} minutes.`,
      'Then end the turn, wait for the user to say they authorized, and call feishu_auth_poll.',
    ].join('\n'), { ...prompt });
  }));

  server.registerTool('feishu_auth_poll', {
    title: 'Confirm Feishu authorization',
    description: 'Call after the user says they confirmed. Waits up to wait_seconds and saves the login once authorized. Returns authorized / pending / denied / expired.',
    inputSchema: { wait_seconds: z.number().int().min(0).max(50).optional().describe('Longest wait in seconds; default 40, max 50') },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, ({ wait_seconds }) => guard(async a => {
    const result = await a.pollLogin((wait_seconds ?? 40) * 1000);
    switch (result.state) {
      case 'authorized':
        return ok(`Authorized: ${result.name ?? ''} (${result.open_id}). ${result.refreshable ? '' : 'Note: no renewal credential was granted, so this login expires in about two hours.'}`.trim(), { ...result });
      case 'pending':
        return ok(`The user has not confirmed yet. Remind them to open the authorization link and confirm; call this tool again in ${result.retry_after_s} s (the authorization stays valid for about ${Math.round(result.expires_in_s / 60)} more minutes).`, { ...result });
      case 'denied':
        return ok('The user denied the authorization. Do not retry; ask whether they want to start a new one.', { ...result });
      case 'expired':
        return ok('The authorization expired. Call feishu_auth_login to start a new one.', { ...result });
    }
  }));

  server.registerTool('feishu_auth_logout', {
    title: 'Log out of Feishu',
    description: "Delete the current user's Feishu login stored on this machine. Call only when the user explicitly asks to log out or switch accounts.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, () => guard(async a => {
    await a.logout();
    return ok('Logged out of Feishu; this machine no longer stores the user\'s login.', { logged_in: false });
  }));

  return server;
}

