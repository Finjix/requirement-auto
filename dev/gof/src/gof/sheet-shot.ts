import { CLS_ORIGIN } from './cls-session.ts';
import { checkPictureTarget, pause, withShotPage, writePicture } from './shot-page.ts';

/*
 * The picture of the 创意进度表 the user gets after the requirement flow: the progress sheet's tab, opened in this user's hidden browser on
 * the rows that were appended, and photographed once the sheet has drawn. The browser is the one the Feishu and CLS logins live in (a
 * Feishu scan logs in the web page too), so the sheet opens as the user. Nothing is clicked or typed, and nothing in the sheet changes:
 * the rows are reached by the link, never by moving around in the sheet.
 */

export interface SheetShotOptions {
  profileDir: string;
  output: string;
  /** The tab's link (https://<company>.feishu.cn/wiki/<node>?sheet=<id>), already checked to be the progress sheet. */
  url: string;
  /** The appended rows in A1 form (A120:Z131): the sheet is opened on them. */
  range?: string | undefined;
  exe?: string | undefined;
  env?: NodeJS.ProcessEnv;
  waitMs?: number;
}

export type SheetShotResult =
  | { state: 'ok'; file: string; where: string }
  | { state: 'login_required'; where: string }
  | { state: 'no_access'; where: string };

const WIDTH = 2000;
const HEIGHT = 1100;

/**
 * Feishu's own link to a range of cells (复制选区链接) names it in `range`, as the base64 of its A1 form. The link only moves the view
 * onto the rows; if Feishu does not understand it the sheet opens at its top, which is why the skill looks at the picture before it
 * hands it over.
 */
export function locatedUrl(url: string, range: string | undefined): string {
  if (!range) return url;
  const target = new URL(url);
  target.searchParams.set('range', Buffer.from(range, 'utf8').toString('base64'));
  return target.toString();
}

/** A page that asks the person to sign in, as Feishu's single sign-on words it. */
const signIn = (here: string): boolean => /^(accounts|passport)\.|\/accounts\/|\/login|\/passport\//.test(here);

export async function sheetScreenshot(options: SheetShotOptions): Promise<SheetShotResult> {
  checkPictureTarget(options.output);
  const home = new URL(options.url).host;
  return withShotPage({ profileDir: options.profileDir, origin: CLS_ORIGIN, exe: options.exe, env: options.env, waitMs: options.waitMs,
    width: WIDTH, height: HEIGHT }, async page => {
    const { evaluate, until, where, wait } = page;
    await page.navigate(locatedUrl(options.url, options.range));
    // On the sheet's own host with a drawing surface, or sent to sign in.
    await until(async () => {
      const here = await where();
      if (!here.startsWith(home) || signIn(here)) return here !== '' && here !== 'about:blank';
      return await evaluate(`document.readyState === 'complete' && document.querySelectorAll('canvas').length > 0`) === true;
    }, wait);
    const here = await where();
    if (!here.startsWith(home) || signIn(here)) return { state: 'login_required', where: here };
    if (await evaluate(`document.querySelectorAll('canvas').length`) === 0) return { state: 'no_access', where: here };
    // The sheet's cells come in after the page: wait for its data to stop arriving, then for the canvas to be painted.
    await page.quiet(2_000, 20_000);
    await pause(1_500);
    return { state: 'ok', file: writePicture(options.output, await page.capture()), where: here };
  });
}
