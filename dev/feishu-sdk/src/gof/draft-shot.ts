import { CLS_ORIGIN } from './cls-session.ts';
import { checkPictureTarget, pause, withShotPage, writePicture } from './shot-page.ts';

/*
 * The picture of a CLS requirement draft the user gets after the requirement flow: the draft's own page (需求草稿, with the imported
 * scripts), opened in this user's hidden CLS browser the way a person reaches it, and photographed once it has been drawn. Like the
 * list picture (creative-shot.ts) nothing is clicked or typed and nothing in CLS changes; a draft is only looked at.
 */

type Obj = Record<string, any>;

export interface DraftShotOptions {
  profileDir: string;
  output: string;
  /** The draft's ID, as the save answered it. */
  draftId: number;
  /** The game the draft belongs to, as CLS lists it (/api/creative/games); the app keeps it as the current game. */
  game: Obj;
  origin?: string;
  exe?: string | undefined;
  env?: NodeJS.ProcessEnv;
  waitMs?: number;
}

export type DraftShotResult =
  | { state: 'ok'; file: string; title: string | null }
  | { state: 'login_required'; where: string }
  | { state: 'no_access'; where: string };

const WIDTH = 1700;
const MIN_HEIGHT = 1000;
/** A draft with many scripts is long; the picture stops here (it is a proof that the draft is there, not a copy of it). */
const MAX_HEIGHT = 2600;

/** The draft's page, as `cls.ts` records its URL. */
export const draftPath = (draftId: number): string => `/requirement/${draftId}/edit-outer`;

export async function draftScreenshot(options: DraftShotOptions): Promise<DraftShotResult> {
  checkPictureTarget(options.output);
  const id = options.draftId;
  return withShotPage({ profileDir: options.profileDir, origin: options.origin ?? CLS_ORIGIN, exe: options.exe, env: options.env, waitMs: options.waitMs,
    width: WIDTH, height: MIN_HEIGHT }, async page => {
    const { evaluate, until, where, answered, wait } = page;
    if (!await page.openAppForGame(options.game)) return { state: 'login_required', where: await where() };
    const read = answered.get(`/api/workflow/script/${id}`) ?? 0;
    // In-app navigation, as a click on the draft in the requirement list does: a fresh page load can be turned away before the app knows its pages.
    const routed = await evaluate(`(async () => { const vm = window.DD_VUE_INSTANCE; if (!vm || !vm.$router) return false; await vm.$router.push(${JSON.stringify(draftPath(id))}); return true; })()`);
    if (!routed) await page.navigate(`${page.origin}${draftPath(id)}`);
    await until(async () => { const at = await where(); return at.endsWith(draftPath(id)) || /feishu|larksuite/.test(at); }, wait);
    const here = await where();
    if (!here.endsWith(draftPath(id))) return { state: /feishu|larksuite/.test(here) ? 'login_required' : 'no_access', where: here };
    // The page asks for the draft itself; if it asks otherwise than this tool knows, the loading marks and the text below decide.
    await until(() => (answered.get(`/api/workflow/script/${id}`) ?? 0) > read, 8_000);
    // The page is drawn when nothing on it is still loading; then its images, and a moment for the last repaint.
    await until(async () => await evaluate(`!document.querySelector('.el-loading-mask') && !!document.body && document.body.innerText.trim().length > 0`) === true, 15_000);
    await page.imagesDrawn('img', 10_000);
    await pause(800);
    const height = Number(await evaluate('Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)')) || MIN_HEIGHT;
    await page.resize(WIDTH, Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, height)));
    await pause(500);
    const title = await evaluate(`document.title || null`);
    return { state: 'ok', file: writePicture(options.output, await page.capture()), title: typeof title === 'string' ? title : null };
  });
}
