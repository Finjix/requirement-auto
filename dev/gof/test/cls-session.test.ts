import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { attachBrowser, findBrowser, openBrowser, browserCandidates, BROWSER_ENV } from '../src/gof/chromium.ts';
import { accountNames, captureAuthorization, captureLoginQr, NO_BROWSER, openSession, whoAmI, type ConsentOptions } from '../src/gof/cls-session.ts';
import { tempDir } from './helpers/tmp.ts';

const exe = findBrowser();
const needBrowser = exe ? {} : { skip: 'no Chrome or Edge on this machine' };

/**
 * A stand-in for CLS: a page whose script calls the API with the token kept in local storage, and an SSO page that stores a token.
 * The first call every page makes carries a stale token, like a single-page app that has not noticed yet that its login ran out.
 */
function fakeCls() {
  const hits = { sso: 0, userinfo: [] as string[] };
  const server = http.createServer((request, response) => {
    const send = (type: string, body: string, status = 200) => { response.writeHead(status, { 'Content-Type': type }); response.end(body); };
    const url = new URL(request.url ?? '/', 'http://x');
    if (url.pathname === '/api/userinfo') {
      const auth = String(request.headers.authorization ?? '');
      hits.userinfo.push(auth);
      return auth === 'Bearer good'
        ? send('application/json', JSON.stringify({ code: 0, data: { id: 7, name: '测试用户', status: 1 } }))
        : send('application/json', JSON.stringify({ code: 401, msg: 'unauthorized' }), 401);
    }
    if (url.pathname === '/sso') {
      hits.sso++;
      return send('text/html', '<script>localStorage.setItem("token","Bearer good");location.replace("/requirements")</script>');
    }
    if (url.pathname === '/requirements') {
      return send('text/html', `<script>
        const token = localStorage.getItem("token");
        fetch("/api/userinfo", { headers: { Authorization: "Bearer stale" } })
          .then(() => token ? fetch("/api/userinfo", { headers: { Authorization: token } }) : location.replace("/sso"));
      </script>`);
    }
    return send('text/plain', 'not found', 404);
  });
  return new Promise<{ origin: string; hits: typeof hits; close: () => void }>(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({ origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits, close: () => { server.closeAllConnections(); server.close(); } }));
  });
}

test('the browser is found from the environment or from the usual places, and nowhere else', () => {
  assert.equal(findBrowser({ [BROWSER_ENV]: 'relative/chrome.exe' }, 'win32'), undefined);
  assert.equal(findBrowser({ [BROWSER_ENV]: path.join(tempDir('browser-'), 'missing.exe') }, 'win32'), undefined);
  assert.ok(browserCandidates('win32', { 'ProgramFiles(x86)': 'C:\\Program Files (x86)' }).some(p => p.endsWith('msedge.exe')));
  assert.ok(browserCandidates('win32', {}).includes(path.join('C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe')), 'a cut-down environment still finds Edge in its usual place');
  assert.ok(browserCandidates('linux', {}).every(p => path.isAbsolute(p)));
});

test('a token is judged by what CLS says about it', async () => {
  const cls = await fakeCls();
  try {
    assert.deepEqual(await whoAmI(cls.origin, 'Bearer good'), { id: 7, name: '测试用户' });
    assert.equal(await whoAmI(cls.origin, 'Bearer stale'), undefined);
    assert.equal(await whoAmI('http://127.0.0.1:9', 'Bearer good'), undefined, 'a server that is not there is not a login');
  } finally { cls.close(); }
});

test('the login is read from the page\'s own requests, a stale token is skipped, and the next run reuses the profile without logging in again', needBrowser, async () => {
  const cls = await fakeCls();
  const profileDir = path.join(tempDir('cls-profile-'), 'browser-profile');
  try {
    const first = await captureAuthorization({ profileDir, waitMs: 30_000, origin: cls.origin, exe });
    assert.equal(first.state, 'ok');
    if (first.state === 'ok') assert.deepEqual([first.authorization, first.account], ['Bearer good', { id: 7, name: '测试用户' }]);
    assert.ok(cls.hits.userinfo.includes('Bearer stale'), 'the page sent its stale token first, as the test intends');
    assert.equal(cls.hits.sso, 1);

    // A new browser process on the same profile: the login was written to the profile when the first one was closed.
    const second = await captureAuthorization({ profileDir, waitMs: 30_000, origin: cls.origin, exe });
    assert.equal(second.state, 'ok');
    assert.equal(cls.hits.sso, 1, 'no second login: the stored one was enough');
  } finally { cls.close(); }
});

/**
 * A CLS whose single sign-on leaves only a session cookie (no expiry), as the real one does; the page asks for its token with that cookie.
 * With `scan`, signing in is not automatic: the page shows a sign-in page (a stand-in for the QR code) until `state.scanned` is set.
 */
function fakeSessionCls(options: { scan?: boolean; consent?: { app: string; account: string } } = {}) {
  const hits = { sso: 0 };
  const state = { scanned: false, decisions: [] as string[] };
  const server = http.createServer((request, response) => {
    const send = (type: string, body: string, status = 200, headers: Record<string, string> = {}) => { response.writeHead(status, { 'Content-Type': type, ...headers }); response.end(body); };
    const url = new URL(request.url ?? '/', 'http://x');
    const signedIn = /(^|; )sid=abc/.test(String(request.headers.cookie ?? ''));
    if (url.pathname === '/api/token') return signedIn ? send('application/json', JSON.stringify({ token: 'Bearer good' })) : send('application/json', '{}', 401);
    if (url.pathname === '/api/userinfo') {
      return request.headers.authorization === 'Bearer good'
        ? send('application/json', JSON.stringify({ code: 0, data: { id: 7, name: '测试用户', status: 1 } }))
        : send('application/json', JSON.stringify({ code: 401 }), 401);
    }
    if (url.pathname === '/scan-status') return send('application/json', JSON.stringify({ scanned: state.scanned }));
    if (url.pathname === '/login-page') {
      return send('text/html', '<body style="margin:0"><div style="width:300px;height:300px;margin:60px;background:#000"></div><script>setInterval(() => fetch("/scan-status").then(r => r.json()).then(s => { if (s.scanned) location.replace("' + (options.consent ? '/consent' : '/sso') + '"); }), 200)</script></body>');
    }
    if (url.pathname === '/consent') {
      const who = options.consent!;
      return send('text/html; charset=utf-8', `<body><p>应用 ${who.app} 请求以下账号进行授权</p><p>${who.account}</p>
        <button id="no" onclick="fetch('/decision?choice=no')">拒绝</button>
        <button id="yes" onclick="fetch('/decision?choice=yes').then(() => location.replace('/sso'))">授权</button></body>`);
    }
    if (url.pathname === '/decision') { state.decisions.push(String(url.searchParams.get('choice'))); return send('application/json', '{}'); }
    if (url.pathname === '/sso') { hits.sso++; return send('text/html', '<script>location.replace("/requirements")</script>', 200, { 'Set-Cookie': 'sid=abc; Path=/; HttpOnly' }); }
    if (url.pathname === '/requirements') {
      return send('text/html', `<script>
        fetch("/api/token").then(r => r.ok ? r.json() : Promise.reject()).then(t => fetch("/api/userinfo", { headers: { Authorization: t.token } })).catch(() => location.replace("${options.scan ? '/login-page' : '/sso'}"));
      </script>`);
    }
    return send('text/plain', 'not found', 404);
  });
  return new Promise<{ origin: string; hits: typeof hits; state: typeof state; close: () => void }>(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({ origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits, state, close: () => { server.closeAllConnections(); server.close(); } }));
  });
}

test('a login that lives only in a session cookie survives the browser being closed and started again', needBrowser, async () => {
  const cls = await fakeSessionCls();
  const profileDir = path.join(tempDir('cls-profile-'), 'browser-profile');
  try {
    const first = await captureAuthorization({ profileDir, waitMs: 30_000, origin: cls.origin, exe });
    assert.equal(first.state, 'ok');
    assert.equal(cls.hits.sso, 1);
    // The first browser was closed the normal way. A browser that forgets session cookies would send the page back to the sign-in.
    const second = await captureAuthorization({ profileDir, waitMs: 30_000, origin: cls.origin, exe });
    assert.equal(second.state, 'ok');
    assert.equal(cls.hits.sso, 1, 'the second run found the login the first one left in the profile');
  } finally { cls.close(); }
});

test('the sign-in QR code is photographed, the hidden browser stays for the scan, and the next command takes the login from it', needBrowser, async () => {
  const cls = await fakeSessionCls({ scan: true });
  const profileDir = path.join(tempDir('cls-profile-'), 'browser-profile');
  const isLoginPage = (url: URL) => url.pathname === '/login-page';
  try {
    const qr = await captureLoginQr({ profileDir, origin: cls.origin, exe, isLoginPage, settleMs: 300 });
    assert.equal(qr.state, 'qr');
    if (qr.state === 'qr') {
      assert.equal(qr.png.subarray(0, 4).toString('hex'), '89504e47', 'a PNG');
      assert.ok(qr.png.length > 2_000, 'a picture of a page, not an empty file');
    }
    const waiting = await attachBrowser(profileDir);
    assert.ok(waiting, 'the browser that shows the code is still running for the scan');
    waiting!.cdp.close();
    assert.equal(cls.hits.sso, 0, 'nobody has signed in yet');

    // Without a scan, looking again finds nobody logged in and leaves the browser where it is.
    const before = await captureAuthorization({ profileDir, waitMs: 1_500, origin: cls.origin, exe });
    assert.equal(before.state, 'login_required');
    const still = await attachBrowser(profileDir);
    assert.ok(still, 'a look that found nothing does not close the browser waiting for the scan');
    still!.cdp.close();

    // The person scans with their phone; the next command picks the login up from the same browser and closes it.
    cls.state.scanned = true;
    const after = await captureAuthorization({ profileDir, waitMs: 20_000, origin: cls.origin, exe });
    assert.equal(after.state, 'ok');
    assert.equal(cls.hits.sso, 1);
    assert.equal(await attachBrowser(profileDir), undefined, 'the login is done, so the browser is gone');

    // And the login stays: the session cookie was kept when the browser was closed.
    const later = await captureAuthorization({ profileDir, waitMs: 20_000, origin: cls.origin, exe });
    assert.equal(later.state, 'ok');
    assert.equal(cls.hits.sso, 1);
  } finally { cls.close(); }
});

/** Photographs the code, then lets the scan happen, so that the browser is left on the consent page. */
async function scanned(cls: Awaited<ReturnType<typeof fakeSessionCls>>, profileDir: string) {
  const qr = await captureLoginQr({ profileDir, origin: cls.origin, exe, isLoginPage: url => url.pathname === '/login-page', settleMs: 300 });
  assert.equal(qr.state, 'qr');
  cls.state.scanned = true;
}
const isConsentPage = (url: URL) => url.pathname === '/consent';

test('after the scan the consent page of the CLS application is approved, and only the button that says 授权 is pressed', needBrowser, async () => {
  const cls = await fakeSessionCls({ scan: true, consent: { app: 'dsc_admin', account: '张三' } });
  const profileDir = path.join(tempDir('cls-profile-'), 'browser-profile');
  const consent: ConsentOptions = { app: 'dsc_admin', account: '张三', isConsentPage };
  try {
    await scanned(cls, profileDir);
    const result = await captureAuthorization({ profileDir, waitMs: 20_000, origin: cls.origin, exe, consent });
    assert.equal(result.state, 'ok');
    assert.deepEqual(cls.state.decisions, ['yes'], 'approved once, and the other button was left alone');
  } finally { cls.close(); }
});

test('with no account pinned yet, the first login is approved for whoever the page names', needBrowser, async () => {
  const cls = await fakeSessionCls({ scan: true, consent: { app: 'dsc_admin', account: '李四' } });
  const profileDir = path.join(tempDir('cls-profile-'), 'browser-profile');
  try {
    await scanned(cls, profileDir);
    const result = await captureAuthorization({ profileDir, waitMs: 20_000, origin: cls.origin, exe, consent: { app: 'dsc_admin', isConsentPage } });
    assert.equal(result.state, 'ok');
    assert.deepEqual(cls.state.decisions, ['yes']);
  } finally { cls.close(); }
});

test('a consent page for another application is not approved, and the browser is left as it is', needBrowser, async () => {
  const cls = await fakeSessionCls({ scan: true, consent: { app: 'some_other_app', account: '张三' } });
  const profileDir = path.join(tempDir('cls-profile-'), 'browser-profile');
  try {
    await scanned(cls, profileDir);
    const result = await captureAuthorization({ profileDir, waitMs: 20_000, origin: cls.origin, exe, consent: { app: 'dsc_admin', account: '张三', isConsentPage } });
    assert.equal(result.state, 'consent_refused');
    if (result.state === 'consent_refused') assert.match(result.reason, /dsc_admin/);
    assert.deepEqual(cls.state.decisions, [], 'nothing was pressed');
    const still = await attachBrowser(profileDir);
    assert.ok(still, 'the page stays where the person can be told about it');
    await still?.close();
  } finally { cls.close(); }
});

test('a consent page for another account than the pinned one is not approved', needBrowser, async () => {
  const cls = await fakeSessionCls({ scan: true, consent: { app: 'dsc_admin', account: '李四' } });
  const profileDir = path.join(tempDir('cls-profile-'), 'browser-profile');
  try {
    await scanned(cls, profileDir);
    const result = await captureAuthorization({ profileDir, waitMs: 20_000, origin: cls.origin, exe, consent: { app: 'dsc_admin', account: '张三', isConsentPage } });
    assert.equal(result.state, 'consent_refused');
    if (result.state === 'consent_refused') assert.match(result.reason, /张三/);
    assert.deepEqual(cls.state.decisions, []);
    await (await attachBrowser(profileDir))?.close();
  } finally { cls.close(); }
});

test('without the consent option nothing is ever pressed', needBrowser, async () => {
  const cls = await fakeSessionCls({ scan: true, consent: { app: 'dsc_admin', account: '张三' } });
  const profileDir = path.join(tempDir('cls-profile-'), 'browser-profile');
  try {
    await scanned(cls, profileDir);
    const result = await captureAuthorization({ profileDir, waitMs: 4_000, origin: cls.origin, exe });
    assert.equal(result.state, 'login_required');
    assert.deepEqual(cls.state.decisions, []);
    await (await attachBrowser(profileDir))?.close();
  } finally { cls.close(); }
});

test('a page that is not a sign-in page is reported as that, not photographed', needBrowser, async () => {
  const cls = await fakeSessionCls();
  const profileDir = path.join(tempDir('cls-profile-'), 'browser-profile');
  try {
    // This server signs in by itself, so the page never stops on a sign-in page.
    const result = await captureLoginQr({ profileDir, origin: cls.origin, exe, isLoginPage: url => url.pathname === '/login-page', waitMs: 4_000, settleMs: 100 });
    assert.equal(result.state, 'not_login_page');
    assert.equal(await attachBrowser(profileDir), undefined, 'a browser started for nothing is not left running');
  } finally { cls.close(); }
});

test('starting the browser again and again on one profile does not pile up tabs', needBrowser, async () => {
  const cls = await fakeCls();
  const profileDir = path.join(tempDir('cls-profile-'), 'browser-profile');
  const counts: number[] = [];
  try {
    for (let run = 0; run < 4; run++) {
      const browser = await openBrowser({ exe: exe!, profileDir });
      try {
        await new Promise(resolve => setTimeout(resolve, 500));
        const { targetInfos } = await browser.cdp.send<{ targetInfos: { type: string; url: string }[] }>('Target.getTargets');
        counts.push(targetInfos.filter(t => t.type === 'page').length);
        if (!targetInfos.some(t => t.type === 'page' && t.url.startsWith(cls.origin))) await browser.cdp.send('Target.createTarget', { url: `${cls.origin}/requirements` });
        await new Promise(resolve => setTimeout(resolve, 500));
      } finally { await browser.close(); }
    }
    assert.ok(counts[3]! <= counts[1]!, `the number of tabs at each start stays put: ${counts.join(', ')}`);
    assert.ok(Math.max(...counts) <= 2, `a restored page and one blank tab at most: ${counts.join(', ')}`);
  } finally { cls.close(); }
});

test('nothing logged in in a hidden browser is reported as a login that is needed, not as a failure', needBrowser, async () => {
  const cls = await fakeCls();
  try {
    // A server that never accepts any token.
    const result = await captureAuthorization({ profileDir: path.join(tempDir('cls-profile-'), 'p'), waitMs: 4_000, origin: `${cls.origin}/nothing-here`, exe });
    assert.equal(result.state, 'login_required');
  } finally { cls.close(); }
});

test('a browser left running on the profile is joined by the next command instead of a second one being started', needBrowser, async () => {
  const profileDir = path.join(tempDir('cls-profile-'), 'p');
  const first = await openBrowser({ exe: exe!, profileDir });
  try {
    assert.equal(first.launched, true);
    const second = await openBrowser({ exe: exe!, profileDir });
    assert.equal(second.launched, false);
    const version = await second.cdp.send<{ product: string }>('Browser.getVersion');
    assert.match(version.product, /Chrome|Edg/);
    second.cdp.close();
  } finally { await first.close(); }
  assert.equal(first.cdp.closed, true);
});

/** Starts a browser from a process of its own, lets go of it unclosed, and reports whether that process ended by itself. */
async function leaveBrowser(profileDir: string, mode: 'detach' | 'attach') {
  const worker = fileURLToPath(new URL('./helpers/leave-browser-open.ts', import.meta.url));
  return new Promise<{ code: number | null; out: string }>(resolve => {
    const child = spawn(process.execPath, [worker, exe!, profileDir, mode], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', chunk => { out += chunk; });
    const timer = setTimeout(() => { child.kill(); resolve({ code: null, out }); }, 20_000);
    child.once('exit', code => { clearTimeout(timer); resolve({ code, out }); });
  });
}

test('a command that leaves a browser waiting for a scan ends at once, and the browser is still there for the next command to join', needBrowser, async () => {
  const profileDir = path.join(tempDir('cls-profile-'), 'p');
  const run = await leaveBrowser(profileDir, 'detach');
  const still = await attachBrowser(profileDir);
  try {
    assert.deepEqual([run.code, run.out.trim()], [0, 'left'], 'the process ended on its own instead of waiting for the window to close');
    assert.ok(still, 'the browser it started outlived it');
  } finally { await still?.close(); }
});

test('a hidden browser does not outlive the command that started it, so nothing is left holding the profile', needBrowser, async () => {
  const profileDir = path.join(tempDir('cls-profile-'), 'p');
  const run = await leaveBrowser(profileDir, 'attach');
  assert.deepEqual([run.code, run.out.trim()], [0, 'left']);
  assert.equal(await attachBrowser(profileDir), undefined);
});

test('the consent page may name the account without the suffix CLS gives its own name, and the browser is named by the shared variable', () => {
  assert.ok(accountNames('钟丰骏-实习生').includes('钟丰骏'));
  assert.ok(accountNames('冯彦蓉－实习生').includes('冯彦蓉'));
  assert.ok(accountNames('张三 — 外包').includes('张三'));
  assert.deepEqual(accountNames('张三'), ['张三']);
  assert.ok(NO_BROWSER.includes(BROWSER_ENV), NO_BROWSER);
});

test('a consent page naming the Feishu name of a pinned "-实习生" account is approved', needBrowser, async () => {
  const cls = await fakeSessionCls({ scan: true, consent: { app: 'dsc_admin', account: '钟丰骏' } });
  const profileDir = path.join(tempDir('cls-profile-'), 'browser-profile');
  try {
    await scanned(cls, profileDir);
    const result = await captureAuthorization({ profileDir, waitMs: 20_000, origin: cls.origin, exe, consent: { app: 'dsc_admin', account: '钟丰骏-实习生', isConsentPage } });
    assert.equal(result.state, 'ok');
    assert.deepEqual(cls.state.decisions, ['yes']);
  } finally { cls.close(); }
});

/** A free port nobody listens on: a site that cannot be reached. */
async function closedPort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

test('CLS out of reach is no lapsed login: neither a token CLS cannot be asked about nor a page that does not load sends anybody to scan', needBrowser, async () => {
  // The page is logged in, but the token check from here gets a gateway's 503 (an outage, or a proxy this process does not go through).
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://x');
    if (url.pathname === '/api/userinfo') {
      if (!/Chrome|Edg/.test(String(request.headers['user-agent']))) { response.writeHead(503); response.end('upstream unavailable'); return; }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ code: 0, data: { id: 7, name: '张三', status: 1 } }));
      return;
    }
    if (url.pathname === '/requirements') { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end('<script>fetch("/api/userinfo", { headers: { Authorization: "Bearer good" } })</script>'); return; }
    response.writeHead(404); response.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const seen = await captureAuthorization({ profileDir: path.join(tempDir('cls-profile-'), 'p'), waitMs: 4_000, origin, exe });
    assert.equal(seen.state, 'unreachable', JSON.stringify(seen));
    await assert.rejects(openSession({ profileDir: path.join(tempDir('cls-profile-'), 'p'), waitMs: 4_000, origin, exe }),
      (error: Error) => /暂时无法访问/.test(error.message) && /不要让用户扫码/.test(error.message) && !/cls login/.test(error.message));
  } finally { server.closeAllConnections(); server.close(); }
  // CLS's page itself does not load.
  const down = await captureAuthorization({ profileDir: path.join(tempDir('cls-profile-'), 'p'), waitMs: 3_000, origin: `http://127.0.0.1:${await closedPort()}`, exe });
  assert.equal(down.state, 'unreachable', JSON.stringify(down));
  if (down.state === 'unreachable') assert.match(down.reason, /ERR_CONNECTION_REFUSED|连接失败/);
});

test('a proxy that would take the browser\'s own 127.0.0.1 traffic is refused before a browser is started, saying what to set', () => {
  const module = pathToFileURL(fileURLToPath(new URL('../src/gof/cls-session.ts', import.meta.url))).href;
  const missing = path.join(tempDir('cls-proxy-'), 'no-such-browser.exe');
  const profile = path.join(tempDir('cls-proxy-'), 'p');
  const probe = `import { captureAuthorization } from ${JSON.stringify(module)};
    captureAuthorization({ profileDir: ${JSON.stringify(profile)}, waitMs: 1, exe: ${JSON.stringify(missing)} }).then(() => console.log('ran'), e => console.log(e.message));`;
  const clean = { NODE_USE_ENV_PROXY: undefined, NODE_OPTIONS: undefined, HTTP_PROXY: undefined, http_proxy: undefined, HTTPS_PROXY: undefined, https_proxy: undefined, NO_PROXY: undefined, no_proxy: undefined };
  const run = (env: Record<string, string>) => spawnSync(process.execPath, ['--input-type=module', '-e', probe], { env: { ...process.env, ...clean, ...env }, encoding: 'utf8' }).stdout.trim();
  const dead = 'http://127.0.0.1:9';
  assert.match(run({ NODE_USE_ENV_PROXY: '1', HTTP_PROXY: dead }), /NO_PROXY=127\.0\.0\.1,localhost/);
  // Not refused (the start of the missing browser is tried) when NO_PROXY keeps 127.0.0.1 out of it, or the proxy is for https only.
  assert.match(run({ NODE_USE_ENV_PROXY: '1', HTTP_PROXY: dead, NO_PROXY: '127.0.0.1,localhost' }), /浏览器没有启动成功/);
  assert.match(run({ NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: dead }), /浏览器没有启动成功/);
  assert.match(run({ HTTP_PROXY: dead }), /浏览器没有启动成功/, 'without NODE_USE_ENV_PROXY Node takes no proxy at all');
});

