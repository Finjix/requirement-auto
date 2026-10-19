import { FeishuApi, type CellWrite } from './api.ts';
import { FeishuAuth } from './auth.ts';
import { loadApp, REQUIRED_SCOPES, type Endpoints } from './config.ts';
import { BridgeError, toPayload, type ErrorPayload } from './errors.ts';
import { expectedOpenId, resolveDataPaths } from './paths.ts';

export type BridgeReply = { ok: true; data: unknown } | { ok: false; error: ErrorPayload };

export interface BridgeContext {
  env?: NodeJS.ProcessEnv;
  endpoints?: Endpoints;
}

export const BRIDGE_VERSION = 'feishu-sdk-bridge/1';
export const COMMANDS = [
  'info', 'auth-status', 'auth-login', 'auth-poll', 'auth-logout', 'auth-check-scopes',
  'api-get', 'sheets-revision', 'sheets-export', 'sheets-cells-set', 'sheets-create',
] as const;

/** Commands that read their arguments from stdin; the rest take none. */
export const INPUT_COMMANDS: ReadonlySet<string> = new Set([
  'auth-login', 'auth-poll', 'auth-check-scopes', 'api-get', 'sheets-revision', 'sheets-export', 'sheets-cells-set', 'sheets-create',
]);

function object(input: unknown, command: string): Record<string, any> {
  if (input === undefined || input === null) return {};
  if (typeof input !== 'object' || Array.isArray(input)) throw new BridgeError('invalid_request', `${command} 需要 JSON 对象参数`);
  return input as Record<string, any>;
}

function strings(value: unknown, name: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string' && item.length < 200)) throw new BridgeError('invalid_request', `${name} 必须是字符串数组`);
  return value;
}

/**
 * One command of the bridge (the gof command line calls this in process). The user this serves comes from the environment the host started the process
 * with; the input has no way to name another one. Never returns a token.
 */
export async function runBridge(command: string, input: unknown, context: BridgeContext = {}): Promise<BridgeReply> {
  const env = context.env ?? process.env;
  let auth: FeishuAuth | undefined;
  try {
    const paths = resolveDataPaths(env);
    let app, missingApp;
    try { app = loadApp(env, paths); } catch (e) {
      if (command !== 'auth-status' && command !== 'auth-logout' && command !== 'info') throw e;
      missingApp = (e as Error).message;
    }
    auth = new FeishuAuth({ paths, app, missingApp, expectedOpenId: expectedOpenId(env), ...(context.endpoints ? { endpoints: context.endpoints } : {}) });
    const api = new FeishuApi(auth);
    const args = object(input, command);
    let data: unknown;
    switch (command) {
      case 'info':
        data = { bridge: BRIDGE_VERSION, node: process.version, storage: paths.mode, app_configured: !!app, required_scopes: REQUIRED_SCOPES };
        break;
      case 'auth-status': data = await auth.status(); break;
      case 'auth-login': data = await auth.startLogin(strings(args.extra_scopes, 'extra_scopes')); break;
      case 'auth-poll': data = await auth.pollLogin(typeof args.wait_ms === 'number' ? args.wait_ms : undefined); break;
      case 'auth-logout': await auth.logout(); data = { logged_in: false }; break;
      case 'auth-check-scopes': {
        const required = strings(args.required, 'required');
        const status = await auth.status(required);
        data = { complete: status.logged_in && !status.missing_scopes?.length, granted: status.scopes ?? [], missing: status.logged_in ? status.missing_scopes ?? [] : required };
        break;
      }
      case 'api-get': data = await api.get(String(args.path ?? ''), object(args.params, 'params')); break;
      case 'sheets-revision': data = { revision: await api.revision(String(args.token ?? '')) }; break;
      case 'sheets-export': data = await api.exportXlsx(String(args.token ?? ''), String(args.output ?? '')); break;
      case 'sheets-cells-set': data = await api.cellsSet(String(args.token ?? ''), args.writes as CellWrite[]); break;
      case 'sheets-create': data = await api.createWorkbook(String(args.title ?? '')); break;
      default: throw new BridgeError('invalid_request', `未知命令：${command}`);
    }
    return { ok: true, data };
  } catch (error) {
    return { ok: false, error: toPayload(error, await auth?.secrets().catch(() => []) ?? []) };
  }
}
