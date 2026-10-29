import { CLS_ORIGIN } from './cls-session.ts';
import { checkPictureTarget, pause, withShotPage, writePicture } from './shot-page.ts';

/*
 * The picture of a requirement document after the agent edited it (gof feishu doc-screenshot for a docx; a sheet goes through
 * sheet-shot.ts): the document opened in this user's hidden browser on the block that was written, photographed once it has drawn.
 * Feishu scrolls a docx to a block when its link ends in #<block ID>. Nothing is clicked or typed.
 */

export interface DocShotOptions {
  profileDir: string;
  output: string;
  /** The document's link (wiki or docx), already checked to be a company Feishu document. */
  url: string;
  /** The block to open the document on (an ID as the docx API gives it). */
  block?: string | undefined;
  exe?: string | undefined;
  env?: NodeJS.ProcessEnv;
  waitMs?: number;
}

export type DocShotResult =
  | { state: 'ok'; file: string; where: string }
  | { state: 'login_required'; where: string }
  | { state: 'no_access'; where: string };

const WIDTH = 1600;
const HEIGHT = 1100;
const signIn = (here: string): boolean => /^(accounts|passport)\.|\/accounts\/|\/login|\/passport\//.test(here);

export async function docScreenshot(options: DocShotOptions): Promise<DocShotResult> {
  checkPictureTarget(options.output);
  const home = new URL(options.url).host;
  const target = new URL(options.url);
  if (options.block) target.hash = options.block;
  return withShotPage({ profileDir: options.profileDir, origin: CLS_ORIGIN, exe: options.exe, env: options.env, waitMs: options.waitMs,
    width: WIDTH, height: HEIGHT }, async page => {
    const { evaluate, until, where, wait } = page;
    await page.navigate(target.toString());
    // On the document's host with its blocks drawn, or sent to sign in.
    await until(async () => {
      const here = await where();
      if (!here.startsWith(home) || signIn(here)) return here !== '' && here !== 'about:blank';
      return await evaluate(`document.readyState === 'complete' && document.querySelectorAll('[data-block-id]').length > 1`) === true;
    }, wait);
    const here = await where();
    if (!here.startsWith(home) || signIn(here)) return { state: 'login_required', where: here };
    if (await evaluate(`document.querySelectorAll('[data-block-id]').length`) <= 1) return { state: 'no_access', where: here };
    // Images and the scroll to the block come after the text.
    await page.quiet(2_000, 20_000);
    await pause(1_500);
    return { state: 'ok', file: writePicture(options.output, await page.capture()), where: here };
  });
}
