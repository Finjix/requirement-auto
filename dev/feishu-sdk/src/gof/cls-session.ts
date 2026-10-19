import path from 'node:path';
import { findBrowser, openBrowser, type BrowserHandle } from './chromium.ts';
import { resolveDataPaths } from '../paths.ts';
import { Blocked } from './util.ts';

/*
 * The CLS login. CLS sits behind the company's single sign-on and offers no device flow or callback, so the one way to obtain a
 * session is for a person to log in on the normal web page. This module opens that page in a browser with its own profile folder
 * (under the user's data directory, so each user keeps their own login), watches the page's ordinary API requests, and takes the
 * Authorization header of the first one the server accepts. The token lives in this process only: it is never written down, printed
 * or put in a record. The browser is closed as soon as it has been seen, and the HTTP work is done from here with the token.
 *
 * What is never done: reading cookies, local storage or the profile files, typing into the page, or changing the page.
 */

export const CLS_ORIGIN = 'https://creative.centurygames.cn';
const ENTRY = '/requirements';

export interface Account { id: number; name: string }

export type Capture =
  | { state: 'ok'; authorization: string; account: Account }
  /** The wait ran out; a login window that was opened for a person is still open. */
  | { state: 'waiting' }
  /** The browser was closed before a logged-in request was seen. */
  | { state: 'closed' }
  /** Nothing logged in showed up in a browser nobody is sitting at. */
  | { state: 'login_required' };

export interface CaptureOptions {
  /** Where the browser keeps its profile. */
  profileDir: string;
  /** Show a window for a person to log in. Otherwise the browser runs hidden and only an existing login can be picked up. */
  headed: boolean;
  /** How long to wait for a logged-in request. */
  waitMs: number;
  /** Tests point this at a local server. Production code never passes it: the command line has no way to name another origin. */
  origin?: string;
  exe?: string | undefined;
  env?: NodeJS.ProcessEnv;
}

/** Asks CLS who the token belongs to; undefined when it is not (or no longer) accepted. */
export async function whoAmI(origin: string, authorization: string, fetcher: typeof fetch = fetch): Promise<Account | undefined> {
  try {
    const response = await fetcher(`${origin}/api/userinfo`, {
      headers: { Authorization: authorization }, redirect: 'error', signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return undefined;
    const body = await response.json() as { code?: number; data?: { id?: unknown; name?: unknown; status?: unknown } };
    const data = body.data;
    if (body.code !== 0 || !data || data.status !== 1 || !Number.isSafeInteger(data.id)) return undefined;
    return { id: data.id as number, name: String(data.name ?? '') };
  } catch { return undefined; }
}

const lower = (headers: Record<string, string> | undefined, name: string): string | undefined =>
  headers ? Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1] : undefined;

/**
 * Opens the CLS page in the profile's browser and returns the first Authorization the server accepts.
 * A browser already running on the profile (a login window an earlier command left open) is joined rather than started again.
 */
export async function captureAuthorization(options: CaptureOptions): Promise<Capture> {
  const origin = options.origin ?? CLS_ORIGIN;
  const exe = options.exe ?? findBrowser(options.env);
  if (!exe) throw new Blocked('没有找到 Chrome 或 Edge：请安装其一，或用环境变量 REQUIREMENT_AUTO_BROWSER 指定浏览器的绝对路径');
  const browser = await openBrowser({ exe, profileDir: options.profileDir, headed: options.headed, ...(options.env ? { env: options.env } : {}) });
  try {
    const result = await watch(browser, origin, options);
    // A window a person is still using stays open: the one this call opened while it waits for them, and one an earlier call opened
    // when this look found no login in it (it may be exactly the login in progress). Anything else has done its job.
    const keepOpen = result.state === 'waiting' || (!browser.launched && result.state === 'login_required');
    if (keepOpen) browser.cdp.close();
    else await browser.close();
    return result;
  } catch (error) {
    await browser.close().catch(() => undefined);
    throw error;
  }
}

async function watch(browser: BrowserHandle, origin: string, options: CaptureOptions): Promise<Capture> {
  const { cdp } = browser;
  const tried = new Set<string>();
  const urls = new Map<string, string>();
  const sessions = new Map<string, Promise<string>>();
  let accepted: ((value: { authorization: string; account: Account }) => void) | undefined;
  const found = new Promise<{ authorization: string; account: Account }>(resolve => { accepted = resolve; });
  let validating = Promise.resolve();

  const consider = (url: string | undefined, authorization: string | undefined): void => {
    if (!authorization || !url?.startsWith(`${origin}/api/`) || tried.has(authorization)) return;
    tried.add(authorization);
    // One at a time, so the first token that is good wins and a stale one that the page sent before it noticed it was logged out is only skipped.
    validating = validating.then(async () => {
      const account = await whoAmI(origin, authorization);
      if (account) accepted?.({ authorization, account });
    });
  };

  /** Attaches to a page once and turns its Network events on; the same promise answers every caller, so nothing navigates before it is listening. */
  const attach = (targetId: string): Promise<string> => {
    let session = sessions.get(targetId);
    if (!session) {
      session = (async () => {
        const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
        await cdp.send('Network.enable', {}, sessionId);
        if (!options.headed) {
          // A hidden browser announces itself as headless; the site should see an ordinary one.
          const { userAgent } = await cdp.send<{ userAgent?: string }>('Browser.getVersion');
          if (userAgent) await cdp.send('Network.setUserAgentOverride', { userAgent: userAgent.replace('HeadlessChrome', 'Chrome') }, sessionId);
        }
        return sessionId;
      })();
      sessions.set(targetId, session);
    }
    return session;
  };
  cdp.on('Target.targetCreated', params => { if (params.targetInfo?.type === 'page') void attach(params.targetInfo.targetId).catch(() => undefined); });
  cdp.on('Network.requestWillBeSent', (params) => {
    const url = params.request?.url as string | undefined;
    if (typeof params.requestId === 'string' && url) urls.set(params.requestId, url);
    consider(url, lower(params.request?.headers, 'authorization'));
  });
  cdp.on('Network.requestWillBeSentExtraInfo', (params) => {
    consider(typeof params.requestId === 'string' ? urls.get(params.requestId) : undefined, lower(params.headers, 'authorization'));
  });

  const closed = new Promise<'closed'>(resolve => cdp.onClose(() => resolve('closed')));
  await cdp.send('Target.setDiscoverTargets', { discover: true });
  const { targetInfos } = await cdp.send<{ targetInfos: { type: string; targetId: string; url: string }[] }>('Target.getTargets');
  const pages = targetInfos.filter(t => t.type === 'page');
  for (const page of pages) await attach(page.targetId).catch(() => undefined);

  const open = pages.find(page => page.url.startsWith(origin));
  const blank = pages.find(page => page.url === 'about:blank' || page.url.startsWith('chrome://newtab') || page.url.startsWith('edge://newtab'));
  const entry = `${origin}${ENTRY}`;
  if (open) await attach(open.targetId).then(session => cdp.send('Page.reload', {}, session)).catch(() => undefined);
  else if (blank) await attach(blank.targetId).then(session => cdp.send('Page.navigate', { url: entry }, session)).catch(() => undefined);
  else if (!pages.some(page => /sso|login|oauth|auth/i.test(page.url))) await cdp.send('Target.createTarget', { url: entry }).catch(() => undefined);

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), options.waitMs); });
  try {
    const outcome = await Promise.race([found, closed, timeout]);
    if (outcome === 'closed') return { state: 'closed' };
    if (outcome === 'timeout') return options.headed ? { state: 'waiting' } : { state: 'login_required' };
    return { state: 'ok', authorization: outcome.authorization, account: outcome.account };
  } finally { clearTimeout(timer); }
}

/** The folders this user's CLS login lives in: the browser profile, under the user's own data directory. */
export function clsProfileDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveDataPaths(env).root, 'cls', 'browser-profile');
}

/** A session for the commands that talk to CLS: whoever is logged in on this user's profile, or a refusal that says to log in. */
export async function openSession(options: Partial<CaptureOptions> = {}): Promise<{ authorization: string; account: Account; origin: string }> {
  const origin = options.origin ?? CLS_ORIGIN;
  const result = await captureAuthorization({ profileDir: options.profileDir ?? clsProfileDir(), headed: false, waitMs: options.waitMs ?? 25_000, ...options });
  if (result.state !== 'ok') throw new Blocked('CLS 未登录或登录已过期：先运行 gof.mjs cls login，请用户在弹出的浏览器窗口里完成公司登录');
  return { authorization: result.authorization, account: result.account, origin };
}
