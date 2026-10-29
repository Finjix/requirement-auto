import fs from 'node:fs';
import path from 'node:path';
import { findBrowser, openBrowser, type Cdp } from './chromium.ts';
import { Blocked, need } from './util.ts';

/*
 * What every picture the skill hands back has in common: this user's own hidden browser (the profile the logins live in) with one page
 * in it, a window of a chosen size, the page's own answers from CLS counted, and a PNG that is never written over an existing file.
 * The pictures only look: nothing is typed, and a click happens nowhere (see creative-shot.ts, draft-shot.ts, sheet-shot.ts).
 */

type Obj = Record<string, any>;

export const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
/** The current game the CLS app keeps in local storage (DD-CLS-GLOBAL-CURGAME). */
const GAME_KEY = 'DD-CLS-GLOBAL-CURGAME';
export const NO_BROWSER = '没有找到 Chrome 或 Edge：请安装其一，或用环境变量 REQUIREMENT_AUTO_BROWSER 指定浏览器的绝对路径';
export const EXISTS = '截图文件已存在，不覆盖；换一个新的 .png 文件名';

/** Checks the target of a picture before anything is started: a .png that does not exist yet. */
export function checkPictureTarget(target: string): string {
  const file = path.resolve(target);
  need(/\.png$/i.test(file), '截图文件需要是 .png');
  need(!fs.existsSync(file), EXISTS);
  return file;
}

/** Writes the picture; an existing file is never overwritten. */
export function writePicture(target: string, png: Buffer): string {
  const file = checkPictureTarget(target);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, png, { flag: 'wx' });
  return file;
}

export interface PageOptions {
  profileDir: string;
  /** The CLS origin whose /api/ answers are counted; tests point this at a local server. */
  origin: string;
  exe?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  /** How long to wait for the app or the page to answer. */
  waitMs?: number | undefined;
  width: number;
  height: number;
}

export interface ShotPage {
  cdp: Cdp;
  sessionId: string;
  origin: string;
  wait: number;
  /** How many times each CLS /api/ path has been answered with 200 since the page was opened. */
  answered: Map<string, number>;
  evaluate: (expression: string) => Promise<any>;
  /** `host/path` of where the page is now ('' when it cannot be told). */
  where: () => Promise<string>;
  until: (condition: () => boolean | Promise<boolean>, ms: number) => Promise<boolean>;
  navigate: (url: string) => Promise<void>;
  resize: (width: number, height: number) => Promise<void>;
  /** The page as it is now, as PNG bytes. */
  capture: () => Promise<Buffer>;
  /** Waits until the page has had no request in flight for `quietMs` (at most `maxMs` in all): its data has come in. True when it got quiet. */
  quiet: (quietMs: number, maxMs: number) => Promise<boolean>;
  /** Waits for the images on the page to be drawn (up to ms). */
  imagesDrawn: (selector: string, ms: number) => Promise<void>;
  /** Opens the CLS app (the requirements page) and waits until it has asked CLS who is logged in and been answered. */
  openApp: () => Promise<boolean>;
  /** Opens the CLS app with `game` as the current game (the app reads it once, at start); false when the app never got its login answered. */
  openAppForGame: (game: Obj) => Promise<boolean>;
}

export async function withShotPage<T>(options: PageOptions, run: (page: ShotPage) => Promise<T>): Promise<T> {
  const exe = options.exe ?? findBrowser(options.env ?? undefined);
  if (!exe) throw new Blocked(NO_BROWSER);
  const wait = options.waitMs ?? 30_000;
  const origin = options.origin;
  const browser = await openBrowser({ exe, profileDir: options.profileDir, ...(options.env ? { env: options.env } : {}) });
  try {
    const { cdp } = browser;
    const { targetInfos } = await cdp.send<{ targetInfos: { type: string; targetId: string }[] }>('Target.getTargets');
    const targetId = targetInfos.find(t => t.type === 'page')?.targetId ?? (await cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' })).targetId;
    const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Network.enable', {}, sessionId);
    const { userAgent } = await cdp.send<{ userAgent?: string }>('Browser.getVersion');
    if (userAgent) await cdp.send('Network.setUserAgentOverride', { userAgent: userAgent.replace('HeadlessChrome', 'Chrome') }, sessionId);
    const resize = async (width: number, height: number) => { await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, sessionId); };
    await resize(options.width, options.height);

    const answered = new Map<string, number>();
    cdp.on('Network.responseReceived', (params, from) => {
      if (from !== sessionId) return;
      try {
        const url = new URL(String(params.response?.url ?? ''));
        if (url.origin === origin && url.pathname.startsWith('/api/') && params.response.status === 200) answered.set(url.pathname, (answered.get(url.pathname) ?? 0) + 1);
      } catch { /* not a URL this cares about */ }
    });
    const inflight = new Set<string>();
    let lastActivity = Date.now();
    const track = (start: boolean) => (params: Obj, from: string | undefined) => {
      if (from !== sessionId) return;
      if (start) inflight.add(String(params.requestId)); else inflight.delete(String(params.requestId));
      lastActivity = Date.now();
    };
    cdp.on('Network.requestWillBeSent', track(true));
    cdp.on('Network.loadingFinished', track(false));
    cdp.on('Network.loadingFailed', track(false));
    const quiet = async (quietMs: number, maxMs: number): Promise<boolean> => {
      for (const end = Date.now() + maxMs; Date.now() < end; await pause(200)) if (inflight.size === 0 && Date.now() - lastActivity >= quietMs) return true;
      return false;
    };
    const evaluate = async (expression: string): Promise<any> =>
      (await cdp.send<{ result: { value?: unknown } }>('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId)).result.value;
    const where = async (): Promise<string> => { try { const u = new URL(String(await evaluate('location.href'))); return `${u.host}${u.pathname}`; } catch { return ''; } };
    const until = async (condition: () => boolean | Promise<boolean>, ms: number): Promise<boolean> => {
      for (const end = Date.now() + ms; Date.now() < end; await pause(250)) if (await condition()) return true;
      return condition();
    };
    const navigate = async (url: string) => { await cdp.send('Page.navigate', { url }, sessionId); };
    const openApp = async (): Promise<boolean> => {
      const before = answered.get('/api/userinfo') ?? 0;
      await navigate(`${origin}/requirements`);
      return until(() => (answered.get('/api/userinfo') ?? 0) > before, wait);
    };
    const openAppForGame = async (game: Obj): Promise<boolean> => {
      if (!await openApp()) return false;
      const current = await evaluate(`(() => { try { return JSON.parse(localStorage.getItem(${JSON.stringify(GAME_KEY)})); } catch { return null; } })()`);
      if (current?.id === game.id) return true;
      // The app reads the current game once, when it starts: set it, then start the app again.
      await evaluate(`localStorage.setItem(${JSON.stringify(GAME_KEY)}, ${JSON.stringify(JSON.stringify(game))}); true`);
      return openApp();
    };
    const capture = async (): Promise<Buffer> => Buffer.from((await cdp.send<{ data: string }>('Page.captureScreenshot', { format: 'png' }, sessionId)).data, 'base64');
    const imagesDrawn = async (selector: string, ms: number): Promise<void> => {
      await until(async () => await evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})].every(i => i.complete)`) === true, ms);
    };
    return await run({ cdp, sessionId, origin, wait, answered, evaluate, where, until, navigate, resize, capture, quiet, imagesDrawn, openApp, openAppForGame });
  } finally {
    await browser.close().catch(() => undefined);
  }
}
