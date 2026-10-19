import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { attachBrowser, findBrowser, openBrowser, browserCandidates, BROWSER_ENV } from '../src/gof/chromium.ts';
import { captureAuthorization, whoAmI } from '../src/gof/cls-session.ts';
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
    const first = await captureAuthorization({ profileDir, headed: false, waitMs: 30_000, origin: cls.origin, exe });
    assert.equal(first.state, 'ok');
    if (first.state === 'ok') assert.deepEqual([first.authorization, first.account], ['Bearer good', { id: 7, name: '测试用户' }]);
    assert.ok(cls.hits.userinfo.includes('Bearer stale'), 'the page sent its stale token first, as the test intends');
    assert.equal(cls.hits.sso, 1);

    // A new browser process on the same profile: the login was written to the profile when the first one was closed.
    const second = await captureAuthorization({ profileDir, headed: false, waitMs: 30_000, origin: cls.origin, exe });
    assert.equal(second.state, 'ok');
    assert.equal(cls.hits.sso, 1, 'no second login: the stored one was enough');
  } finally { cls.close(); }
});

test('nothing logged in in a hidden browser is reported as a login that is needed, not as a failure', needBrowser, async () => {
  const cls = await fakeCls();
  try {
    // A server that never accepts any token.
    const result = await captureAuthorization({ profileDir: path.join(tempDir('cls-profile-'), 'p'), headed: false, waitMs: 4_000, origin: `${cls.origin}/nothing-here`, exe });
    assert.equal(result.state, 'login_required');
  } finally { cls.close(); }
});

test('a browser left running on the profile is joined by the next command instead of a second one being started', needBrowser, async () => {
  const profileDir = path.join(tempDir('cls-profile-'), 'p');
  const first = await openBrowser({ exe: exe!, profileDir, headed: false });
  try {
    assert.equal(first.launched, true);
    const second = await openBrowser({ exe: exe!, profileDir, headed: false });
    assert.equal(second.launched, false);
    const version = await second.cdp.send<{ product: string }>('Browser.getVersion');
    assert.match(version.product, /Chrome|Edg/);
    second.cdp.close();
  } finally { await first.close(); }
  assert.equal(first.cdp.closed, true);
});

// Opens a real, visible browser window for a few seconds, so it only runs when asked for: REQUIREMENT_AUTO_TEST_HEADED=1 npm test
test('a login window that is still being used stays open between commands, and the next command picks the login up from it', { skip: !exe || !process.env.REQUIREMENT_AUTO_TEST_HEADED }, async () => {
  const state = { loggedIn: false };
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://x');
    if (url.pathname === '/api/userinfo') {
      const ok = request.headers.authorization === 'Bearer good';
      response.writeHead(ok ? 200 : 401, { 'Content-Type': 'application/json' });
      return void response.end(JSON.stringify(ok ? { code: 0, data: { id: 7, name: '测试用户', status: 1 } } : { code: 401 }));
    }
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end(state.loggedIn
      ? '<script>fetch("/api/userinfo",{headers:{Authorization:"Bearer good"}})</script>logged in'
      : '<body>Please log in (test page)</body>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const profileDir = path.join(tempDir('cls-profile-'), 'browser-profile');
  try {
    const first = await captureAuthorization({ profileDir, headed: true, waitMs: 3_000, origin, exe });
    assert.equal(first.state, 'waiting');
    const stillOpen = await attachBrowser(profileDir);
    assert.ok(stillOpen, 'the window is still there');
    stillOpen.cdp.close();

    state.loggedIn = true;
    const second = await captureAuthorization({ profileDir, headed: true, waitMs: 15_000, origin, exe });
    assert.equal(second.state, 'ok');
    assert.equal(await attachBrowser(profileDir), undefined, 'the window is closed once the login has been seen');
  } finally { server.closeAllConnections(); server.close(); }
});
