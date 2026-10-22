import fs from 'node:fs';
import path from 'node:path';
import { findBrowser, openBrowser } from './chromium.ts';
import { CLS_ORIGIN } from './cls-session.ts';
import { Blocked, need } from './util.ts';

/*
 * The picture of 我的创意 > 创意列表 the user gets after an upload. It is taken in this user's own hidden CLS browser (the profile the login
 * lives in), the way a person would see the list: the app is opened, the list is shown for GOFCN with the uploads of this account,
 * newest first (the list's own saved filter, set in this profile's local storage), and a screenshot is taken once the rows and their
 * thumbnails are drawn. Nothing is clicked or typed, and nothing in CLS changes.
 */

type Obj = Record<string, any>;

export interface ShotOptions {
  profileDir: string;
  output: string;
  /** The account whose uploads the list shows (上传人). */
  accountId: number;
  /** The game the list is shown for, as CLS lists it (/api/creative/games); the app keeps it as the current game. */
  game: Obj;
  /** How many rows the picture should have room for. */
  rows?: number;
  origin?: string;
  exe?: string | undefined;
  env?: NodeJS.ProcessEnv;
  waitMs?: number;
}

export type ShotResult =
  | { state: 'ok'; file: string; rows: number; total: string | null }
  | { state: 'login_required'; where: string }
  | { state: 'no_access'; where: string };

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
/** The list's search conditions as the page saves them (DD_CLS_CREATIVES_CONFIRMED_SEARCH_CONDITIONS), and the current game (DD-CLS-GLOBAL-CURGAME). */
const FILTER_KEY = 'DD_CLS_CREATIVES_CONFIRMED_SEARCH_CONDITIONS';
const GAME_KEY = 'DD-CLS-GLOBAL-CURGAME';

/** Writes the picture; an existing file is never overwritten. */
function writePicture(target: string, png: Buffer): string {
  const file = path.resolve(target);
  need(/\.png$/i.test(file), '截图文件需要是 .png');
  need(!fs.existsSync(file), '截图文件已存在，不覆盖；换一个新的 .png 文件名');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, png, { flag: 'wx' });
  return file;
}

export async function listScreenshot(options: ShotOptions): Promise<ShotResult> {
  const origin = options.origin ?? CLS_ORIGIN;
  const exe = options.exe ?? findBrowser(options.env);
  if (!exe) throw new Blocked('没有找到 Chrome 或 Edge：请安装其一，或用环境变量 REQUIREMENT_AUTO_BROWSER 指定浏览器的绝对路径');
  need(!fs.existsSync(path.resolve(options.output)), '截图文件已存在，不覆盖；换一个新的 .png 文件名');
  const rows = Math.max(1, Math.min(options.rows ?? 8, 12));
  const wait = options.waitMs ?? 30_000;
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
    // Wide enough for every column of the list (创意人, 制作人, 上传人, 同步AdsDesk), tall enough for the rows; the table takes its height from the window.
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 2000, height: Math.max(1000, 420 + 160 * rows), deviceScaleFactor: 1, mobile: false }, sessionId);

    const answered = new Map<string, number>();
    cdp.on('Network.responseReceived', (params, from) => {
      if (from !== sessionId) return;
      try {
        const url = new URL(String(params.response?.url ?? ''));
        if (url.origin === origin && url.pathname.startsWith('/api/') && params.response.status === 200) answered.set(url.pathname, (answered.get(url.pathname) ?? 0) + 1);
      } catch { /* not a URL this cares about */ }
    });
    const evaluate = async (expression: string): Promise<any> =>
      (await cdp.send<{ result: { value?: unknown } }>('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId)).result.value;
    const where = async (): Promise<string> => { try { const u = new URL(String(await evaluate('location.href'))); return `${u.host}${u.pathname}`; } catch { return ''; } };
    const until = async (condition: () => boolean | Promise<boolean>, ms: number): Promise<boolean> => {
      for (const end = Date.now() + ms; Date.now() < end; await pause(250)) if (await condition()) return true;
      return condition();
    };
    /** Opens the app and waits until it has asked CLS who is logged in (and been answered): from then on it knows its pages. */
    const openApp = async (): Promise<boolean> => {
      const before = answered.get('/api/userinfo') ?? 0;
      await cdp.send('Page.navigate', { url: `${origin}/requirements` }, sessionId);
      return until(() => (answered.get('/api/userinfo') ?? 0) > before, wait);
    };

    if (!await openApp()) return { state: 'login_required', where: await where() };
    const current = await evaluate(`(() => { try { return JSON.parse(localStorage.getItem(${JSON.stringify(GAME_KEY)})); } catch { return null; } })()`);
    if (current?.id !== options.game.id) {
      // The app reads the current game once, when it starts: set it, then start the app again.
      await evaluate(`localStorage.setItem(${JSON.stringify(GAME_KEY)}, ${JSON.stringify(JSON.stringify(options.game))}); true`);
      if (!await openApp()) return { state: 'login_required', where: await where() };
    }
    const filter = { page: 1, page_size: 50, upload_users: [options.accountId], tags: [], custom_tags: [], sort_field: 'updated_at', sort_order: 'desc', game_id: options.game.id };
    await evaluate(`localStorage.setItem(${JSON.stringify(FILTER_KEY)}, ${JSON.stringify(JSON.stringify(filter))}); true`);
    const listed = answered.get('/api/creatives') ?? 0;
    // In-app navigation, as the menu item does: a fresh page load of the list can be turned away before the app knows its pages.
    const routed = await evaluate(`(async () => { const vm = window.DD_VUE_INSTANCE; if (!vm || !vm.$router) return false; await vm.$router.push({ name: 'CREATIVITY-LIST' }); return true; })()`);
    if (!routed) await cdp.send('Page.navigate', { url: `${origin}/creativities` }, sessionId);
    await until(() => (answered.get('/api/creatives') ?? 0) > listed, wait);
    const page = await where();
    if (!page.endsWith('/creativities')) return { state: /feishu|larksuite/.test(page) ? 'login_required' : 'no_access', where: page };
    // The rows (or the empty-list text), then their thumbnails.
    await until(async () => await evaluate(`document.querySelectorAll('.el-table__body-wrapper tbody tr').length > 0 || !!document.querySelector('.el-table__empty-text')`) === true, 15_000);
    await until(async () => await evaluate(`[...document.querySelectorAll('.el-table__body-wrapper img')].every(i => i.complete)`) === true, 10_000);
    await pause(800);
    const state = await evaluate(`({ rows: document.querySelectorAll('.el-table__body-wrapper tbody tr').length, total: (document.querySelector('.el-pagination__total') || {}).textContent || null })`);
    const shot = await cdp.send<{ data: string }>('Page.captureScreenshot', { format: 'png' }, sessionId);
    return { state: 'ok', file: writePicture(options.output, Buffer.from(shot.data, 'base64')), rows: Number(state?.rows ?? 0), total: state?.total ?? null };
  } finally {
    await browser.close().catch(() => undefined);
  }
}
