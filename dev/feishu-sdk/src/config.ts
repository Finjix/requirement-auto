import fs from 'node:fs';
import path from 'node:path';
import { BridgeError } from './errors.ts';
import type { DataPaths } from './paths.ts';

export interface AppCredentials { appId: string; appSecret: string }
export interface Endpoints {
  /** Open API host, e.g. https://open.feishu.cn */
  open: string;
  /** Accounts host: device authorization and the unified OAuth token endpoint */
  accounts: string;
}

export const FEISHU: Endpoints = { open: 'https://open.feishu.cn', accounts: 'https://accounts.feishu.cn' };

/** What the requirement-auto workflow needs from a user: read wiki/doc/sheet, export workbooks, append to the progress sheet. */
export const REQUIRED_SCOPES: readonly string[] = [
  'wiki:wiki:readonly', 'sheets:spreadsheet:readonly', 'sheets:spreadsheet:read', 'sheets:spreadsheet:write_only',
  'sheets:spreadsheet', 'drive:export:readonly', 'docx:document:readonly',
];
/** Requested on top so the refresh token is issued. It is not a permission and is not part of the checks. */
export const OFFLINE_SCOPE = 'offline_access';

/**
 * The Feishu app the logins belong to. The host passes FEISHU_APP_ID / FEISHU_APP_SECRET in the environment of the process it
 * starts. Without a host (plugin used on its own) the same two values can sit in <data root>/app.json as {"appId", "appSecret"};
 * in host mode the file is never read, so no secret lands in a user's directory.
 */
export function loadApp(env: NodeJS.ProcessEnv = process.env, paths?: Pick<DataPaths, 'mode' | 'root'>): AppCredentials {
  let appId = (env.FEISHU_APP_ID ?? '').trim();
  let appSecret = (env.FEISHU_APP_SECRET ?? '').trim();
  if ((!appId || !appSecret) && paths && paths.mode !== 'host') {
    try {
      const file = JSON.parse(fs.readFileSync(path.join(paths.root, 'app.json'), 'utf8'));
      appId = appId || String(file.appId ?? '').trim();
      appSecret = appSecret || String(file.appSecret ?? '').trim();
    } catch { /* not there, or not readable: reported below */ }
  }
  if (!appId || !appSecret) {
    const alone = paths && paths.mode !== 'host';
    throw new BridgeError('config', alone
      ? `未配置飞书应用：设置环境变量 FEISHU_APP_ID / FEISHU_APP_SECRET，或把 {"appId": "...", "appSecret": "..."} 写入 ${path.join(paths.root, 'app.json')}`
      : '未配置飞书应用：需要环境变量 FEISHU_APP_ID 和 FEISHU_APP_SECRET（由宿主传入）');
  }
  return { appId, appSecret };
}

export function scopeList(scope: string | undefined): string[] {
  return [...new Set((scope ?? '').split(/[\s,]+/).filter(Boolean))];
}
