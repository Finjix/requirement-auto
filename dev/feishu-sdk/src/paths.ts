import os from 'node:os';
import path from 'node:path';
import { BridgeError } from './errors.ts';

/**
 * Where one user's data lives. The directory is decided by the host (lark-agent) for the Codex process it starts, never by a
 * tool argument or by the model: whoever is served by this process can only reach this one directory.
 */
export interface DataPaths {
  /** host: LARK_AGENT_USER_DIR was given; plugin-data: PLUGIN_DATA; standalone: the home folder fallback */
  mode: 'host' | 'plugin-data' | 'standalone';
  root: string;
  feishu: string;
  auth: string;
  login: string;
  lock: string;
  batches: string;
  /** intermediate files of a task (catalog, snapshots, requests); like the batches they are removed once old, see retention.ts */
  tmp: string;
}

function absolute(name: string, value: string): string {
  if (value.includes('\0') || !path.isAbsolute(value)) throw new BridgeError('config', `${name} 必须是绝对路径`);
  const resolved = path.resolve(value);
  if (path.dirname(resolved) === resolved) throw new BridgeError('config', `${name} 不能是磁盘根目录`);
  return resolved;
}

function layout(mode: DataPaths['mode'], root: string): DataPaths {
  const feishu = path.join(root, 'feishu');
  return {
    mode, root, feishu, auth: path.join(feishu, 'auth.json'), login: path.join(feishu, 'login.json'),
    lock: path.join(feishu, 'refresh.lock'), batches: path.join(root, 'batches'),
    tmp: path.join(root, 'tmp'),
  };
}

export const USER_DIR_ENV = 'LARK_AGENT_USER_DIR';
export const OPEN_ID_ENV = 'LARK_AGENT_USER_OPEN_ID';

export function resolveDataPaths(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): DataPaths {
  const userDir = env[USER_DIR_ENV]?.trim();
  if (userDir) return layout('host', path.join(absolute(USER_DIR_ENV, userDir), 'requirement-auto'));
  // A host that names the user but not the directory has forgotten the directory: falling back to a folder shared by everybody
  // would let that user's logins and batches be reached by the next one.
  if (env[OPEN_ID_ENV]?.trim()) throw new BridgeError('config', `${OPEN_ID_ENV} 已设置但没有 ${USER_DIR_ENV}：拒绝回落到共享目录`);
  const pluginData = env.PLUGIN_DATA?.trim();
  if (pluginData) return layout('plugin-data', absolute('PLUGIN_DATA', pluginData));
  return layout('standalone', path.join(home, '.requirement-auto', 'default'));
}

/** The Feishu Open ID the host says this process serves, if it said so. Logging in as anybody else is refused. */
export function expectedOpenId(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env[OPEN_ID_ENV]?.trim();
  if (!value) return undefined;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new BridgeError('config', `${OPEN_ID_ENV} 格式无效`);
  return value;
}
