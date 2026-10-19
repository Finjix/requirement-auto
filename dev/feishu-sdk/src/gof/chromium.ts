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
    if (process.platform === 'win32') execFile('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve());
    else { try { process.kill(pid, 'SIGKILL'); } catch { /* gone already */ } resolve(); }
  });
}

/** Joins a browser that is already running on this profile (a login window left open by an earlier command), if there is one. */
export async function attachBrowser(profileDir: string): Promise<BrowserHandle | undefined> {
  const found = readActivePort(profileDir);
  if (!found) return undefined;
  let cdp: Cdp;
  try { cdp = await Cdp.connect(`ws://127.0.0.1:${found.port}${found.path}`, 2_000); } catch { return undefined; }
  return {
    cdp, launched: false,
    async close() {
      await cdp.send('Browser.close', {}, undefined, 5_000).catch(() => undefined);
      for (let waited = 0; !cdp.closed && waited < 8_000; waited += 100) await sleep(100);
      cdp.close();
    },
  };
}

export interface LaunchOptions {
  exe: string;
  profileDir: string;
  /** A visible window, for a person to use; otherwise the browser runs without one. */
  headed: boolean;
  env?: NodeJS.ProcessEnv;
}

export async function launchBrowser(options: LaunchOptions): Promise<BrowserHandle> {
  const { exe, profileDir, headed } = options;
  fs.mkdirSync(profileDir, { recursive: true });
  fs.rmSync(activePortFile(profileDir), { force: true });
  const args = [
    `--user-data-dir=${profileDir}`, '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check', '--disable-sync',
    '--disable-background-networking', '--disable-component-update', '--password-store=basic', '--disable-features=Translate',
    ...(headed ? ['--new-window'] : ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--mute-audio']),
    'about:blank',
  ];
  const child: ChildProcess = spawn(exe, args, { stdio: 'ignore', windowsHide: !headed, env: options.env ?? process.env });
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

/** Joins the browser on this profile or starts one. */
export async function openBrowser(options: LaunchOptions): Promise<BrowserHandle> {
  return (await attachBrowser(options.profileDir)) ?? launchBrowser(options);
}

