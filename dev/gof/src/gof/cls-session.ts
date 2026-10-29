import path from 'node:path';
import { findBrowser, openBrowser, type BrowserHandle, type Cdp } from './chromium.ts';
import { resolveDataPaths } from '../paths.ts';
import { browserProfileDir } from './feishu-plugin.ts';
import { Blocked } from './util.ts';

/*
 * The CLS login. CLS sits behind the company's single sign-on and offers no device flow or callback, so the one way to obtain a
 * session is for a person to log in on the normal web page. This module opens that page in a browser with its own profile folder
 * (under the user's data directory, so each user keeps their own login), watches the page's ordinary API requests, and takes the
 * Authorization header of the first one the server accepts. The token lives in this process only: it is never written down, printed
 * or put in a record. The browser is closed as soon as it has been seen, and the HTTP work is done from here with the token.
 *
 * What is never done: reading cookies, local storage or the profile files, typing into the page, or changing the page.
 * The one thing that is done to a page is on Feishu's consent page for the CLS application, after the person has scanned the code
 * with their own phone: see approveConsent.
 */

export const CLS_ORIGIN = 'https://creative.centurygames.cn';
const ENTRY = '/requirements';

export interface Account { id: number; name: string }

export type Capture =
  | { state: 'ok'; authorization: string; account: Account }
  /** The browser was closed before a logged-in request was seen. */
  | { state: 'closed' }
  /** Nothing logged in showed up in a browser nobody is sitting at. */
  | { state: 'login_required' }
  /** A consent page was waiting that is not the one this tool approves; nothing was clicked. */
  | { state: 'consent_refused'; reason: string };

export interface CaptureOptions {
  /** Where the browser keeps its profile. */
  profileDir: string;
  /** How long to wait for a logged-in request. */
  waitMs: number;
  /** Tests point this at a local server. Production code never passes it: the command line has no way to name another origin. */
  origin?: string;
  exe?: string | undefined;
  env?: NodeJS.ProcessEnv;
  /** Approve Feishu's consent page for the CLS application when it shows up while waiting. Without it nothing is ever clicked. */
  consent?: ConsentOptions;
}

/**
 * After the scan, Feishu asks the person to let the CLS application (the company's own single sign-on app) use their account. The
 * person has just scanned the code on their own phone for exactly this login, and has said once, for good, that this consent is to be
 * given, so it is given here. The approval is narrow: only the named application, only when the page names the pinned account (if
 * there is one), only the "授权" button, and once per page. Anything else is left alone and reported.
 */
export interface ConsentOptions {
  /** The only application whose request is approved; the page has to name it. Without it any application's page is approved (the device login: see feishu-web.ts). */
  app?: string | undefined;
  /** The account the login is pinned to, if any; the page has to name it too. */
  account?: string | undefined;
  /** The login is pinned to an account whose name is not known: the page cannot be checked, so nothing is clicked. */
  unnamedPin?: boolean;
  /** Is this address a page that may hold the consent? Defaults to Feishu's authorize page. */
  isConsentPage?: (url: URL) => boolean;
}

export type ConsentAttempt = { state: 'clicked' } | { state: 'not_ready' } | { state: 'refused'; reason: string };

const feishuConsentPage = (url: URL): boolean => /^accounts\.(feishu\.cn|larksuite\.com)$/.test(url.hostname) && url.pathname.startsWith('/open-apis/authen/v1/authorize');

// Runs in the consent page: its text (compared here, never printed or stored) and where its "授权" button is.
const CONSENT_PROBE = `(() => {
  const norm = s => (s || '').replace(/\\s+/g, '');
  const candidates = [...document.querySelectorAll('button, [role="button"], a, div, span')].filter(e => e.children.length === 0 && norm(e.textContent) === '授权');
  const element = candidates.map(e => e.closest('button, [role="button"]') || e).find(e => {
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && !e.disabled && e.getAttribute('aria-disabled') !== 'true';
  });
  let button = null;
  if (element) {
    element.scrollIntoView({ block: 'center' });
    const r = element.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const hit = document.elementFromPoint(x, y);
    // Only a button that really is under the pointer: a banner or dialog over it would take the click.
    if (hit && (element === hit || element.contains(hit))) button = { x, y };
  }
  return { href: location.href, text: document.body ? document.body.innerText : '', button };
})()`;

/** The names a company account may be shown under: the whole name, and the parts of "name（alias）". */
export function accountNames(name: string): string[] {
  const parts = [name, ...name.split(/[（()）]/).map(part => part.trim())];
  return [...new Set(parts.filter(part => part.length >= 2))];
}

export async function approveConsent(cdp: Cdp, sessionId: string, options: ConsentOptions, beforeClick: () => void = () => undefined): Promise<ConsentAttempt> {
  const probe = await cdp.send<{ result: { value?: { href: string; text: string; button: { x: number; y: number } | null } } }>(
    'Runtime.evaluate', { expression: CONSENT_PROBE, returnByValue: true }, sessionId);
  const page = probe.result.value;
  if (!page?.button) return { state: 'not_ready' }; // not a consent page (it also shows the sign-in code), or not drawn yet
  // The page may have moved on since the targets were listed: look at where it is now.
  let here: URL;
  try { here = new URL(page.href); } catch { return { state: 'not_ready' }; }
  if (!(options.isConsentPage ?? feishuConsentPage)(here)) return { state: 'not_ready' };
  if (options.app && !page.text.includes(options.app)) return { state: 'refused', reason: `飞书授权页请求的不是 ${options.app}，没有点击；请用户自己查看这个授权请求` };
  if (options.unnamedPin) return { state: 'refused', reason: '已绑定的 CLS 账号没有名称，无法核对授权页上的账号，没有点击；请管理员处理账号绑定' };
  if (options.account && !accountNames(options.account).some(name => page.text.includes(name))) {
    return { state: 'refused', reason: `飞书授权页上的账号不是已绑定的“${options.account}”，没有点击；请用绑定的账号扫码` };
  }
  const { x, y } = page.button;
  beforeClick(); // from here on this login counts as approved once, whatever the click does
  await cdp.send('Page.bringToFront', {}, sessionId).catch(() => undefined);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, sessionId);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, sessionId);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, sessionId);
  return { state: 'clicked' };
}

/** Asks CLS who the token belongs to; undefined when it is not (or no longer) accepted. */
export async function whoAmI(origin: string, authorization: string, fetcher: typeof fetch = fetch): Promise<Account | undefined> {
  const result = await checkToken(origin, authorization, fetcher);
  return 'account' in result ? result.account : undefined;
}

/** Like whoAmI, but says whether the server turned the token down or simply could not be asked (network, proxy, 5xx, timeout). */
export async function checkToken(origin: string, authorization: string, fetcher: typeof fetch = fetch): Promise<{ account: Account } | { rejected: true } | { unreachable: true }> {
  try {
    const response = await fetcher(`${origin}/api/userinfo`, {
      headers: { Authorization: authorization }, redirect: 'error', signal: AbortSignal.timeout(10_000),
    });
    if (response.status >= 500 || response.status === 429 || response.status === 408) return { unreachable: true };
    if (!response.ok) return { rejected: true };
    const body = await response.json() as { code?: number; data?: { id?: unknown; name?: unknown; status?: unknown } } | null;
    const data = body?.data;
    if (body?.code !== 0 || !data || data.status !== 1 || !Number.isSafeInteger(data.id)) return { rejected: true };
    return { account: { id: data.id as number, name: String(data.name ?? '') } };
  } catch { return { unreachable: true }; }
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
  const browser = await openBrowser({ exe, profileDir: options.profileDir, ...(options.env ? { env: options.env } : {}) });
  try {
    const result = await watch(browser, origin, options);
    // A browser an earlier call left waiting for a scan stays open when this look found no login in it (it may be exactly the login in
    // progress). Anything else has done its job.
    const keepOpen = !browser.launched && (result.state === 'login_required' || result.state === 'consent_refused');
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
      const checked = await checkToken(origin, authorization);
      if ('account' in checked) accepted?.({ authorization, account: checked.account });
      else if ('unreachable' in checked) tried.delete(authorization); // not the server's no: the next request with this token asks again
    });
  };

  /** Attaches to a page once and turns its Network events on; the same promise answers every caller, so nothing navigates before it is listening. */
  const attach = (targetId: string): Promise<string> => {
    let session = sessions.get(targetId);
    if (!session) {
      session = (async () => {
        const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
        await cdp.send('Network.enable', {}, sessionId);
        // A hidden browser announces itself as headless; the site should see an ordinary one.
        const { userAgent } = await cdp.send<{ userAgent?: string }>('Browser.getVersion');
        if (userAgent) await cdp.send('Network.setUserAgentOverride', { userAgent: userAgent.replace('HeadlessChrome', 'Chrome') }, sessionId);
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

  // The consent page is looked for on a short interval for as long as the login is awaited. One login is approved once: after the
  // first click nothing else is pressed, even if another tab shows the same page.
  const clicked = new Set<string>();
  let refuse: ((reason: string) => void) | undefined;
  const refused = new Promise<{ refused: string }>(resolve => { refuse = reason => resolve({ refused: reason }); });
  let looking = false;
  const lookForConsent = async (): Promise<void> => {
    const consent = options.consent;
    if (!consent || looking || clicked.size > 0) return;
    looking = true;
    try {
      const { targetInfos } = await cdp.send<{ targetInfos: { type: string; targetId: string; url: string }[] }>('Target.getTargets');
      for (const target of targetInfos) {
        if (target.type !== 'page') continue;
        let url: URL;
        try { url = new URL(target.url); } catch { continue; }
        if (!(consent.isConsentPage ?? feishuConsentPage)(url)) continue;
        const result = await approveConsent(cdp, await attach(target.targetId), consent, () => clicked.add(target.targetId));
        if (result.state === 'clicked') break;
        if (result.state === 'refused') refuse?.(result.reason);
      }
    } catch { /* the next look tries again */ } finally { looking = false; }
  };
  let looker: NodeJS.Timeout | undefined;
  let timer: NodeJS.Timeout | undefined;
  const closed = new Promise<'closed'>(resolve => cdp.onClose(() => resolve('closed')));
  try {
    looker = options.consent ? setInterval(() => void lookForConsent(), 700) : undefined;
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

    const timeout = new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), options.waitMs); });
    const outcome = await Promise.race([found, closed, timeout, refused]);
    if (outcome === 'closed') return { state: 'closed' };
    if (outcome === 'timeout') return { state: 'login_required' };
    if ('refused' in outcome) return { state: 'consent_refused', reason: outcome.refused };
    return { state: 'ok', authorization: outcome.authorization, account: outcome.account };
  } finally { clearTimeout(timer); clearInterval(looker); }
}

export interface QrOptions {
  profileDir: string;
  /** Tests point this at a local server; the command line has no way to name another origin. */
  origin?: string;
  exe?: string | undefined;
  env?: NodeJS.ProcessEnv;
  /** Is this address the page that shows the sign-in QR code? Defaults to the Feishu sign-in page. */
  isLoginPage?: (url: URL) => boolean;
  /** How long to wait for that page to come up, and then for the code on it to be drawn. */
  waitMs?: number;
  settleMs?: number;
}

export type QrCapture =
  | { state: 'qr'; png: Buffer }
  /** The page did not stop on a sign-in page (it may already be signed in, or be somewhere unexpected); `where` is host and path only. */
  | { state: 'not_login_page'; where: string };

const feishuLoginPage = (url: URL): boolean => /^accounts\.(feishu\.cn|larksuite\.com)$/.test(url.hostname) && url.pathname.includes('login');
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * Takes a picture of the sign-in page's QR code so that it can be sent to the person who has to scan it with their phone. This is
 * the one place a screenshot is taken, and what it shows is the sign-in challenge itself: nothing of the page's content is read.
 * The browser is hidden and stays running afterwards (it outlives this process), so that the scan can finish the login there;
 * the next `cls session` joins it, takes the token, and closes it.
 */
export async function captureLoginQr(options: QrOptions): Promise<QrCapture> {
  const origin = options.origin ?? CLS_ORIGIN;
  const exe = options.exe ?? findBrowser(options.env);
  if (!exe) throw new Blocked('没有找到 Chrome 或 Edge：请安装其一，或用环境变量 REQUIREMENT_AUTO_BROWSER 指定浏览器的绝对路径');
  const isLoginPage = options.isLoginPage ?? feishuLoginPage;
  const browser = await openBrowser({ exe, profileDir: options.profileDir, detach: true, ...(options.env ? { env: options.env } : {}) });
  let leaveRunning = true;
  try {
    const { cdp } = browser;
    const { targetInfos } = await cdp.send<{ targetInfos: { type: string; targetId: string }[] }>('Target.getTargets');
    const targetId = targetInfos.find(t => t.type === 'page')?.targetId ?? (await cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' })).targetId;
    const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Page.enable', {}, sessionId);
    const { userAgent } = await cdp.send<{ userAgent?: string }>('Browser.getVersion');
    if (userAgent) await cdp.send('Network.setUserAgentOverride', { userAgent: userAgent.replace('HeadlessChrome', 'Chrome') }, sessionId);
    // A narrow, sharp page: the code fills most of the picture, which is read off a phone screen.
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 640, height: 720, deviceScaleFactor: 2, mobile: false }, sessionId);
    // Always start from the entry page, so that the code is a fresh one.
    await cdp.send('Page.navigate', { url: `${origin}${ENTRY}` }, sessionId);

    // Right after a navigation starts the page is being swapped and the question fails for a moment: that is "not there yet".
    const where = async (): Promise<URL | undefined> => {
      try {
        const history = await cdp.send<{ currentIndex: number; entries: { url: string }[] }>('Page.getNavigationHistory', {}, sessionId);
        return new URL(history.entries[history.currentIndex]?.url ?? '');
      } catch { return undefined; }
    };
    let current: URL | undefined;
    for (const deadline = Date.now() + (options.waitMs ?? 20_000); Date.now() < deadline; await pause(250)) {
      current = await where();
      if (current && isLoginPage(current)) break;
      current = undefined;
    }
    if (!current) {
      const url = await where();
      // A browser this call started and that is not on a sign-in page has nothing to wait for.
      if (browser.launched) leaveRunning = false;
      return { state: 'not_login_page', where: url ? `${url.host}${url.pathname}` : '' };
    }
    await pause(options.settleMs ?? 2_500);
    const now = await where();
    if (!now || !isLoginPage(now)) {
      if (browser.launched) leaveRunning = false;
      return { state: 'not_login_page', where: now ? `${now.host}${now.pathname}` : '' };
    }
    const shot = await cdp.send<{ data: string }>('Page.captureScreenshot', { format: 'png' }, sessionId);
    return { state: 'qr', png: Buffer.from(shot.data, 'base64') };
  } catch (error) {
    leaveRunning = false;
    throw error;
  } finally {
    if (leaveRunning) browser.cdp.close();
    else await browser.close().catch(() => undefined);
  }
}

/**
 * The browser this user's CLS login lives in. It is the feishu plugin's (under the user's own directory): CLS signs in through the company's
 * Feishu single sign-on, and that browser holds the user's Feishu web session from the Feishu login, so the user scans once for both.
 */
export function clsProfileDir(env: NodeJS.ProcessEnv = process.env): string {
  return browserProfileDir(env);
}

/** Where the QR picture that is waiting to be scanned is recorded (see cls-guard.ts). */
export function clsQrFile(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveDataPaths(env).cls, 'login-qr.json');
}

/** Which CLS account this user's login is pinned to (id and name only; see cls-guard.ts). */
export function clsAccountFile(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveDataPaths(env).cls, 'account.json');
}

/** A session for the commands that talk to CLS: whoever is logged in on this user's profile, or a refusal that says to log in. */
export async function openSession(options: Partial<CaptureOptions> = {}): Promise<{ authorization: string; account: Account; origin: string }> {
  const origin = options.origin ?? CLS_ORIGIN;
  const result = await captureAuthorization({ profileDir: options.profileDir ?? clsProfileDir(), waitMs: options.waitMs ?? 25_000, ...options });
  if (result.state === 'consent_refused') throw new Blocked(result.reason);
  if (result.state !== 'ok') throw new Blocked('CLS 未登录或登录已过期：先运行 gof.mjs cls login --qr <png文件> 生成登录二维码，交给用户用飞书手机端扫码');
  return { authorization: result.authorization, account: result.account, origin };
}
