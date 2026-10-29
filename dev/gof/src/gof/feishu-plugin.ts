import { execFileSync, spawn, type ChildProcessByStdio } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { Readable, Writable } from 'node:stream';
import { Blocked } from './util.ts';

type Child = ChildProcessByStdio<Writable, Readable, null>;

/*
 * Feishu is the feishu plugin's (github.com/Finjix/feishu): the login, the allowlisted API calls and the hidden browser that holds the
 * user's Feishu web session all live there, shared with every plugin that works in Feishu, so the user logs in once. This file is how
 * requirement-auto reaches it: it finds the plugin's feishu.mjs and runs it with this process's environment (the host's user directory,
 * Open ID and app), so it serves the same user. The contract is the plugin's docs/for-plugins.md; nothing of the plugin is imported.
 */

/** What a bridge command answers (the plugin's bridge.ts). */
export type BridgeReply = { ok: true; data: unknown } | { ok: false; error: { kind: string; message: string; code?: number } };

/** The bridge protocol this code speaks; the plugin says its own in `info.bridge`. */
export const BRIDGE_VERSION = 'feishu-sdk-bridge/1';
export const FEISHU_PLUGIN_ENV = 'FEISHU_PLUGIN';
const ENTRY = path.join('server', 'dist', 'feishu.mjs');
export const MISSING = '没有找到 feishu 插件（飞书登录和飞书接口都由它提供）：lark-agent 里把 feishu 插件文件夹放进 plugins/ 并重启；单独使用时安装 feishu@feishu';

const isFile = (file: string) => fs.statSync(file, { throwIfNoEntry: false })?.isFile() === true;
const dirs = (dir: string): string[] => { try { return fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name); } catch { return []; } };
const byVersion = (a: string, b: string) => {
  const parts = (v: string) => v.split(/[.+-]/).map(p => (/^\d+$/.test(p) ? Number(p) : p));
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const [p, q] = [x[i] ?? 0, y[i] ?? 0];
    if (p !== q) return typeof p === 'number' && typeof q === 'number' ? q - p : String(q).localeCompare(String(p));
  }
  return 0;
};
/** The newest version folder of a plugin in Codex's cache (`<plugin>/<version>/server/dist/feishu.mjs`). */
const newest = (pluginDir: string): string | undefined =>
  dirs(pluginDir).sort(byVersion).map(version => path.join(pluginDir, version, ENTRY)).find(isFile);

/**
 * Where feishu.mjs is: FEISHU_PLUGIN when it is set, else the first match going up from this file: the plugin folder next to this one
 * (lark-agent's plugins/), Codex's plugin cache (the same marketplace, or another), or the feishu repository next to this one (development).
 */
export function locateFeishu(env: NodeJS.ProcessEnv = process.env, from: string = fileURLToPath(import.meta.url)): string {
  const named = env[FEISHU_PLUGIN_ENV]?.trim();
  if (named) {
    if (path.isAbsolute(named) && isFile(named)) return named;
    throw new Blocked(`${FEISHU_PLUGIN_ENV} 不是 feishu.mjs 的绝对路径`);
  }
  for (let dir = path.dirname(from), level = 0; level < 8; level++) {
    const found = [path.join(dir, 'feishu', ENTRY)].find(isFile) ?? newest(path.join(dir, 'feishu'))
      ?? dirs(dir).map(market => newest(path.join(dir, market, 'feishu'))).find(Boolean)
      ?? [path.join(dir, 'feishu', 'plugins', 'feishu', ENTRY)].find(isFile);
    if (found) return found;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new Blocked(MISSING);
}

/** A feishu.mjs command a skill would run (login, authorize): its one line of JSON and its exit code. */
export function runFeishu(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<{ result: Record<string, any>; code: number }> {
  const entry = locateFeishu(env);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...args], { env, stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
    let out = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { out += chunk; });
    child.once('error', reject);
    child.once('close', code => {
      try { resolve({ result: JSON.parse(out.trim().split('\n').pop() ?? ''), code: code ?? 2 }); } catch { reject(new Blocked('feishu 插件没有给出结果')); }
    });
  });
}

/**
 * The feishu plugin's bridge, one `feishu.mjs serve` process for the whole of this command: started at the first call, ended by close()
 * (or when this process ends). A call whose process went away before it answered rejects, which the caller treats as no answer.
 */
export class FeishuServe {
  private child: Child | undefined;
  private next = 1;
  private readonly waiting = new Map<number, { resolve: (reply: BridgeReply) => void; reject: (error: Error) => void }>();
  private readonly env: NodeJS.ProcessEnv;

  constructor(env: NodeJS.ProcessEnv = process.env) { this.env = env; }

  private start(): Child {
    if (this.child) return this.child;
    const child = spawn(process.execPath, [locateFeishu(this.env), 'serve'], { env: this.env, stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
    readline.createInterface({ input: child.stdout }).on('line', line => {
      let message: { id?: unknown; reply?: BridgeReply };
      try { message = JSON.parse(line); } catch { return; }
      const waiter = typeof message.id === 'number' ? this.waiting.get(message.id) : undefined;
      if (!waiter || !message.reply) return;
      this.waiting.delete(message.id as number);
      this.hold();
      waiter.resolve(message.reply);
    });
    const gone = (error: Error) => {
      if (this.child === child) this.child = undefined;
      for (const waiter of this.waiting.values()) waiter.reject(error);
      this.waiting.clear();
    };
    child.once('error', error => gone(error));
    child.once('close', () => gone(new Error('feishu 插件进程已结束')));
    this.child = child;
    return child;
  }

  /** While an answer is awaited the child keeps this process alive; idle, it does not (the process may end, and the child with its input). */
  private hold(): void {
    const child = this.child;
    if (!child) return;
    const busy = this.waiting.size > 0;
    for (const handle of [child, child.stdin, child.stdout] as unknown as { ref?: () => void; unref?: () => void }[]) (busy ? handle.ref : handle.unref)?.call(handle);
  }

  call(command: string, input: unknown): Promise<BridgeReply> {
    const child = this.start();
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.hold();
      child.stdin.write(`${JSON.stringify({ id, command, input })}\n`);
    });
  }

  /** Lets the plugin's process finish what it has and end. */
  close(): void {
    this.child?.stdin.end();
    this.child = undefined;
  }
}

let shared: FeishuServe | undefined;
export const feishuServe = (): FeishuServe => (shared ??= new FeishuServe());
export const closeFeishu = (): void => { shared?.close(); shared = undefined; };

const profiles = new Map<string, string>();
/**
 * The profile of this user's hidden browser, which is the feishu plugin's: its Feishu web session is what CLS's single sign-on and the
 * sheet screenshots need, so one scan covers them all. Asked of the plugin once per user directory.
 */
export function browserProfileDir(env: NodeJS.ProcessEnv = process.env): string {
  const key = env.LARK_AGENT_USER_DIR ?? '';
  const known = profiles.get(key);
  if (known) return known;
  let info: { ok?: boolean; data?: { bridge?: string; browser_profile?: unknown } };
  try {
    info = JSON.parse(execFileSync(process.execPath, [locateFeishu(env), 'bridge', 'info'], { env, encoding: 'utf8', windowsHide: true, timeout: 30_000 }));
  } catch (error) {
    if (error instanceof Blocked) throw error;
    const out = (error as { stdout?: string }).stdout;
    try { info = JSON.parse(out ?? ''); } catch { throw new Blocked('feishu 插件没有给出浏览器的位置'); }
  }
  const profile = info?.data?.browser_profile;
  if (!info?.ok || typeof profile !== 'string' || !path.isAbsolute(profile)) throw new Blocked(`feishu 插件没有给出浏览器的位置${info?.ok === false ? `：${(info as { error?: { message?: string } }).error?.message ?? ''}` : ''}`);
  profiles.set(key, profile);
  return profile;
}
