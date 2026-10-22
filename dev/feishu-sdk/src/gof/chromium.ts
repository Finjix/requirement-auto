import { spawn, execFile, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Blocked } from './util.ts';

/*
 * A minimal Chromium driver: find the Chrome or Edge that is already installed, start it with its own profile folder and
 * speak the DevTools protocol to it over a WebSocket. No download, no npm dependency, no UI automation: it exists so that a
 * person can log in to a web site in an ordinary browser window and the login can then be observed.
 */

type Obj = Record<string, any>;
type Handler = (params: Obj, sessionId: string | undefined) => void;

/** Environment variable that names the browser executable to use instead of searching for one. */
export const BROWSER_ENV = 'REQUIREMENT_AUTO_BROWSER';

/** The browsers searched, in order, when the environment does not name one. Edge ships with Windows 10 and 11, so it is the usual find there. */
export function browserCandidates(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string[] {
  if (platform === 'win32') {
    // The usual folders are listed too: a process whose environment was cut down (a shell started by an agent, say) may not carry these variables.
    const roots = [env['ProgramFiles(x86)'], env.ProgramFiles, env.LOCALAPPDATA, 'C:\\Program Files (x86)', 'C:\\Program Files'].filter((v): v is string => !!v);
    const relative = [['Microsoft', 'Edge', 'Application', 'msedge.exe'], ['Google', 'Chrome', 'Application', 'chrome.exe'], ['Chromium', 'Application', 'chrome.exe']];
    return relative.flatMap(parts => roots.map(root => path.join(root, ...parts)));
  }
  if (platform === 'darwin') {
    return ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium'];
  }
  return ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/microsoft-edge', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'];
}

export function findBrowser(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | undefined {
  const named = env[BROWSER_ENV]?.trim();
  if (named) return path.isAbsolute(named) && fs.statSync(named, { throwIfNoEntry: false })?.isFile() ? named : undefined;
  return browserCandidates(platform, env).find(file => fs.statSync(file, { throwIfNoEntry: false })?.isFile());
}

/** A DevTools protocol connection: commands with replies, events, and flattened per-target sessions. */
export class Cdp {
  private readonly ws: WebSocket;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private readonly handlers = new Map<string, Set<Handler>>();
  private readonly closers = new Set<() => void>();
  closed = false;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener('message', event => this.receive(String(event.data)));
    ws.addEventListener('close', () => this.finish());
    ws.addEventListener('error', () => this.finish());
  }

  static connect(url: string, timeoutMs = 10_000): Promise<Cdp> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => { ws.close(); reject(new Error('DevTools 连接超时')); }, timeoutMs);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(new Cdp(ws)); }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('DevTools 连接失败')); }, { once: true });
    });
  }

  private receive(text: string): void {
    let message: Obj;
    try { message = JSON.parse(text); } catch { return; }
    if (typeof message.id === 'number') {
      const waiting = this.pending.get(message.id);
      if (!waiting) return;
      this.pending.delete(message.id);
      clearTimeout(waiting.timer);
      if (message.error) waiting.reject(new Error(String(message.error.message ?? 'DevTools 命令失败')));
      else waiting.resolve(message.result ?? {});
    } else if (typeof message.method === 'string') {
      for (const handler of this.handlers.get(message.method) ?? []) handler(message.params ?? {}, message.sessionId);
    }
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiting of this.pending.values()) { clearTimeout(waiting.timer); waiting.reject(new Error('DevTools 连接已关闭')); }
    this.pending.clear();
    for (const closer of this.closers) closer();
  }

  send<T = Obj>(method: string, params: Obj = {}, sessionId?: string, timeoutMs = 30_000): Promise<T> {
    if (this.closed) return Promise.reject(new Error('DevTools 连接已关闭'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`DevTools 命令超时：${method}`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  on(method: string, handler: Handler): () => void {
    let set = this.handlers.get(method);
    if (!set) this.handlers.set(method, set = new Set());
    set.add(handler);
    return () => { set.delete(handler); };
  }

  /** Called once when the connection ends, whichever side ended it (it is called at once if it already has). */
  onClose(handler: () => void): void {
    if (this.closed) handler();
    else this.closers.add(handler);
  }

  close(): void {
    try { this.ws.close(); } catch { /* already closed */ }
    this.finish();
  }
}

export interface BrowserHandle {
  cdp: Cdp;
  /** True when this call started the browser; false when it joined one that was already running on the profile. */
  launched: boolean;
  /** Closes the browser the graceful way, so cookies and local storage are written to the profile; ends it by force if it will not go. */
  close(): Promise<void>;
}

const activePortFile = (profileDir: string) => path.join(profileDir, 'DevToolsActivePort');
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function readActivePort(profileDir: string): { port: number; path: string } | undefined {
  try {
    const [port, endpoint] = fs.readFileSync(activePortFile(profileDir), 'utf8').split(/\r?\n/);
    const number = Number(port);
    if (Number.isInteger(number) && number > 0 && endpoint?.startsWith('/devtools/browser/')) return { port: number, path: endpoint };
  } catch { /* no browser has been started on this profile, or it is just starting */ }
  return undefined;
}

function killTree(pid: number): Promise<void> {
  return new Promise(resolve => {
    if (process.platform === 'win32') execFile(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve());
    else { try { process.kill(pid, 'SIGKILL'); } catch { /* gone already */ } resolve(); }
  });
}

/** Whether a browser's DevTools endpoint answers on this port. */
async function answers(port: number, timeoutMs = 3_000): Promise<boolean> {
  try { return (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(timeoutMs) })).ok; } catch { return false; }
}

/** Joins a browser that is already running on this profile (a login window left open by an earlier command), if there is one. */
async function joinBrowser(profileDir: string): Promise<BrowserHandle | undefined> {
  const found = readActivePort(profileDir);
  if (!found) return undefined;
  const url = `ws://127.0.0.1:${found.port}${found.path}`;
  let cdp: Cdp;
  try { cdp = await Cdp.connect(url, 2_000); } catch {
    // The port file of a browser that was killed stays behind; a running one that is only slow to answer must not be taken for gone: a second
    // browser started on its profile is handed over to it by Chrome and exits, and the port file deleted on the way leaves it unreachable.
    if (!await answers(found.port)) return undefined;
    try { cdp = await Cdp.connect(url, 15_000); } catch { throw new Blocked('这个用户的浏览器在运行，但调试接口没有响应；请稍后再试'); }
  }
  return {
    cdp, launched: false,
    async close() {
      await cdp.send('Browser.close', {}, undefined, 5_000).catch(() => undefined);
      for (let waited = 0; !cdp.closed && waited < 8_000; waited += 100) await sleep(100);
      cdp.close();
      // The connection drops before the browser has finished going; the next command must not meet one that is still on its way out.
      for (let waited = 0; waited < 8_000 && await answers(found.port, 500); waited += 250) await sleep(250);
    },
  };
}

/*
 * One command at a time drives a profile's browser. Two would share its first tab and one would close the browser under the other. The lock
 * is a file beside the profile, held from opening the browser until this process lets go of it: by closing the browser, or only its
 * connection when the browser is left running for a scan. A holder whose process has ended does not count. Within one process the lock is
 * shared (nested opens of a profile are the caller's own business).
 */
const LOCK_WAIT_MS = 120_000, LOCK_STALE_MS = 15 * 60_000;
const held = new Map<string, number>();

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** Whether a lock file is of nobody any more: its process ended, it is very old, or it was never finished being written. */
function abandoned(file: string, text: string): boolean {
  let holder: { pid?: unknown; at?: unknown } | undefined;
  try { holder = JSON.parse(text); } catch { /* half written */ }
  if (typeof holder?.pid !== 'number' || typeof holder.at !== 'number') {
    const age = Date.now() - (fs.statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? 0);
    return age > 10_000;
  }
  return !alive(holder.pid) || Date.now() - holder.at > LOCK_STALE_MS;
}

export async function lockProfile(profileDir: string, waitMs = LOCK_WAIT_MS): Promise<() => void> {
  const file = `${path.resolve(profileDir)}.lock`;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    const left = (held.get(file) ?? 1) - 1;
    if (left > 0) held.set(file, left);
    else { held.delete(file); fs.rmSync(file, { force: true }); }
  };
  if (held.has(file)) { held.set(file, held.get(file)! + 1); return release; }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (const deadline = Date.now() + waitMs; ;) {
    try {
      fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: 'wx' });
      held.set(file, 1);
      return release;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; } // let go of a moment ago
    if (abandoned(file, text)) {
      // Taken away under a name of its own, so that of several waiters seeing the same dead lock none removes a lock just made by another.
      const aside = `${file}.${process.pid}-${Math.random().toString(16).slice(2)}`;
      try { fs.renameSync(file, aside); } catch { continue; }
      let moved = '';
      try { moved = fs.readFileSync(aside, 'utf8'); } catch { /* gone */ }
      if (moved === text) fs.rmSync(aside, { force: true });
      else { try { fs.renameSync(aside, file); } catch { fs.rmSync(aside, { force: true }); } }
      continue;
    }
    if (Date.now() > deadline) {
      throw new Blocked('这个用户的浏览器正被另一个命令使用：同一时间只能运行一个用到浏览器的命令（登录、检查登录、截图、素材上传），请等它结束后再运行');
    }
    await sleep(250);
  }
}

/** The handle with the profile lock: let go of when the browser is closed, or when only its connection is (the browser left running). */
function holding(handle: BrowserHandle, release: () => void): BrowserHandle {
  let closing = false;
  handle.cdp.onClose(() => { if (!closing) release(); });
  return { ...handle, async close() { closing = true; try { await handle.close(); } finally { release(); } } };
}

/** Joins a browser that is already running on this profile (a login window left open by an earlier command), if there is one. */
export async function attachBrowser(profileDir: string): Promise<BrowserHandle | undefined> {
  const release = await lockProfile(profileDir);
  try {
    const handle = await joinBrowser(profileDir);
    if (!handle) { release(); return undefined; }
    return holding(handle, release);
  } catch (error) { release(); throw error; }
}

export interface LaunchOptions {
  exe: string;
  profileDir: string;
  /**
   * Let the browser outlive this process. By default it does not: Node (libuv on Windows) puts a child in a job that ends with its
   * parent, which is what a hidden browser should do, so a crashed command leaves none behind. A browser that is left waiting for a
   * person to scan a QR code is the opposite: it keeps running when the command returns, and the next command joins it.
   */
  detach?: boolean;
  env?: NodeJS.ProcessEnv;
}

export async function launchBrowser(options: LaunchOptions): Promise<BrowserHandle> {
  const { exe, profileDir } = options;
  const detach = options.detach ?? false;
  fs.mkdirSync(profileDir, { recursive: true });
  fs.rmSync(activePortFile(profileDir), { force: true });
  const args = [
    // CLS signs in through the company's Feishu SSO, whose cookies are session-only. A browser that exits normally forgets those,
    // so every later command would find nobody logged in; "continue where you left off" is what makes it keep them.
    `--user-data-dir=${profileDir}`, '--restore-last-session', '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check', '--disable-sync',
    '--disable-background-networking', '--disable-component-update', '--password-store=basic', '--disable-features=Translate',
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--mute-audio',
    'about:blank',
  ];
  const child: ChildProcess = spawn(exe, args, { stdio: 'ignore', windowsHide: true, detached: detach, env: options.env ?? process.env });
  // This process must not wait for the browser to exit: one left waiting for a scan outlives the command.
  child.unref();
  let exited = false;
  let startFailure = '';
  child.once('exit', () => { exited = true; });
  child.once('error', error => { exited = true; startFailure = error.message; });
  let found: { port: number; path: string } | undefined;
  for (let waited = 0; waited < 30_000 && !found; waited += 100) {
    found = readActivePort(profileDir);
    if (found) break;
    if (exited) break;
    await sleep(100);
  }
  if (!found) {
    if (child.pid && !exited) await killTree(child.pid);
    throw new Blocked(`浏览器没有启动成功${startFailure ? `（${startFailure}）` : ''}；确认已安装 Chrome 或 Edge，或用 ${BROWSER_ENV} 指定浏览器路径`);
  }
  const cdp = await Cdp.connect(`ws://127.0.0.1:${found.port}${found.path}`).catch(async error => {
    if (child.pid) await killTree(child.pid);
    throw new Blocked(`无法连接浏览器的调试接口：${(error as Error).message}`);
  });
  await closeSpareBlankTabs(cdp);
  return {
    cdp, launched: true,
    async close() {
      await cdp.send('Browser.close', {}, undefined, 5_000).catch(() => undefined);
      for (let waited = 0; !exited && waited < 8_000; waited += 100) await sleep(100);
      if (!exited && child.pid) await killTree(child.pid);
      cdp.close();
    },
  };
}

/**
 * Restoring the last session brings back last time's tabs, and the address given on the command line opens one more blank tab on top
 * of them, so the blank tabs would add up with every start. One is kept for the command to use.
 */
async function closeSpareBlankTabs(cdp: Cdp): Promise<void> {
  try {
    const { targetInfos } = await cdp.send<{ targetInfos: { type: string; targetId: string; url: string }[] }>('Target.getTargets');
    const blanks = targetInfos.filter(t => t.type === 'page' && t.url === 'about:blank');
    for (const spare of blanks.slice(1)) await cdp.send('Target.closeTarget', { targetId: spare.targetId }).catch(() => undefined);
  } catch { /* the tabs are only tidied; the browser works either way */ }
}

/** Joins the browser on this profile or starts one; another command using the profile is waited for. */
export async function openBrowser(options: LaunchOptions): Promise<BrowserHandle> {
  const release = await lockProfile(options.profileDir);
  try { return holding((await joinBrowser(options.profileDir)) ?? await launchBrowser(options), release); } catch (error) { release(); throw error; }
}

