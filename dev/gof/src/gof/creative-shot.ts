import { CLS_ORIGIN } from './cls-session.ts';
import { checkPictureTarget, pause, withShotPage, writePicture } from './shot-page.ts';

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

/** The list's search conditions as the page saves them (DD_CLS_CREATIVES_CONFIRMED_SEARCH_CONDITIONS). */
const FILTER_KEY = 'DD_CLS_CREATIVES_CONFIRMED_SEARCH_CONDITIONS';

export async function listScreenshot(options: ShotOptions): Promise<ShotResult> {
  checkPictureTarget(options.output);
  const rows = Math.max(1, Math.min(options.rows ?? 8, 12));
  // Wide enough for every column of the list (创意人, 制作人, 上传人, 同步AdsDesk), tall enough for the rows; the table takes its height from the window.
  return withShotPage({ profileDir: options.profileDir, origin: options.origin ?? CLS_ORIGIN, exe: options.exe, env: options.env, waitMs: options.waitMs,
    width: 2000, height: Math.max(1000, 420 + 160 * rows) }, async page => {
    const { evaluate, until, where, answered, wait } = page;
    if (!await page.openAppForGame(options.game)) return { state: 'login_required', where: await where() };
    const filter = { page: 1, page_size: 50, upload_users: [options.accountId], tags: [], custom_tags: [], sort_field: 'updated_at', sort_order: 'desc', game_id: options.game.id };
    await evaluate(`localStorage.setItem(${JSON.stringify(FILTER_KEY)}, ${JSON.stringify(JSON.stringify(filter))}); true`);
    const listed = answered.get('/api/creatives') ?? 0;
    // In-app navigation, as the menu item does: a fresh page load of the list can be turned away before the app knows its pages.
    const routed = await evaluate(`(async () => { const vm = window.DD_VUE_INSTANCE; if (!vm || !vm.$router) return false; await vm.$router.push({ name: 'CREATIVITY-LIST' }); return true; })()`);
    if (!routed) await page.navigate(`${page.origin}/creativities`);
    await until(() => (answered.get('/api/creatives') ?? 0) > listed, wait);
    const here = await where();
    if (!here.endsWith('/creativities')) return { state: /feishu|larksuite/.test(here) ? 'login_required' : 'no_access', where: here };
    // The rows (or the empty-list text), then their thumbnails.
    await until(async () => await evaluate(`document.querySelectorAll('.el-table__body-wrapper tbody tr').length > 0 || !!document.querySelector('.el-table__empty-text')`) === true, 15_000);
    await page.imagesDrawn('.el-table__body-wrapper img', 10_000);
    await pause(800);
    const state = await evaluate(`({ rows: document.querySelectorAll('.el-table__body-wrapper tbody tr').length, total: (document.querySelector('.el-pagination__total') || {}).textContent || null })`);
    return { state: 'ok', file: writePicture(options.output, await page.capture()), rows: Number(state?.rows ?? 0), total: state?.total ?? null };
  });
}
