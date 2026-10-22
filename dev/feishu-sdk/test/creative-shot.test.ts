import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { findBrowser } from '../src/gof/chromium.ts';
import { listScreenshot } from '../src/gof/creative-shot.ts';
import { GAME } from './helpers/fake-creative.ts';
import { tempDir } from './helpers/tmp.ts';

const exe = findBrowser();
const needBrowser = exe ? {} : { skip: 'no Chrome or Edge on this machine' };

/**
 * A stand-in for the CLS app as far as the picture needs it: the app asks who is logged in, keeps its current game and the list's
 * search conditions in local storage, and its router draws the list from /api/creatives. `loggedIn: false` stops on a sign-in page.
 */
function fakeApp(loggedIn = true) {
  const seen: string[] = [];
  const page = `<!doctype html><body><div id="app"></div><script>
    fetch('/api/userinfo', { headers: { Authorization: 'Bearer good' } }).then(() => {
      window.DD_VUE_INSTANCE = { $router: { push: async () => {
        history.pushState({}, '', '/creativities');
        const game = JSON.parse(localStorage.getItem('DD-CLS-GLOBAL-CURGAME') || '{}');
        const filter = JSON.parse(localStorage.getItem('DD_CLS_CREATIVES_CONFIRMED_SEARCH_CONDITIONS') || '{}');
        const r = await fetch('/api/creatives?game_id=' + game.id + (filter.upload_users || []).map(u => '&upload_users[]=' + u).join(''));
        const { data } = await r.json();
        document.getElementById('app').innerHTML = '<div class="el-table__body-wrapper"><table><tbody>'
          + data.creatives.map(c => '<tr><td><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></td><td>' + c.name + '</td></tr>').join('')
          + '</tbody></table></div><span class="el-pagination__total">共 ' + data.total + ' 条</span>';
      } } };
    });
  </script></body>`;
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://x');
    seen.push(`${url.pathname}${url.search}`);
    const send = (type: string, body: string) => { response.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` }); response.end(body); };
    if (url.pathname === '/requirements') return send('text/html', loggedIn ? page : '<script>location.replace("/feishu-login")</script>');
    if (url.pathname === '/feishu-login') return send('text/html', '<p>扫码登录</p>');
    if (url.pathname === '/api/userinfo') return send('application/json', JSON.stringify({ code: 0, data: { id: 1565, status: 1 } }));
    if (url.pathname === '/api/creatives') {
      return send('application/json', JSON.stringify({ code: 0, data: { total: 2, creatives: [{ id: 2, name: 'GOFCN66367_片头' }, { id: 1, name: '封面' }] } }));
    }
    response.writeHead(404); response.end();
  });
  return new Promise<{ origin: string; seen: string[]; close: () => void }>(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({ origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, close: () => { server.closeAllConnections(); server.close(); } }));
  });
}

test('the list picture shows GOFCN and this account’s uploads, newest first, and never overwrites a file', needBrowser, async () => {
  const app = await fakeApp();
  try {
    const output = path.join(tempDir('shot-'), 'creatives.png');
    const result = await listScreenshot({ profileDir: tempDir('shot-profile-'), output, accountId: 1565, game: GAME, rows: 3, origin: app.origin, exe, waitMs: 15_000 });
    assert.equal(result.state, 'ok', JSON.stringify(result));
    if (result.state !== 'ok') return;
    assert.equal(result.rows, 2);
    assert.equal(result.total, '共 2 条');
    assert.deepEqual([...fs.readFileSync(output).subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], 'a PNG');
    assert.ok(app.seen.includes('/api/creatives?game_id=94&upload_users[]=1565'), `the list asked for GOFCN and this account: ${app.seen.join(' ')}`);
    await assert.rejects(listScreenshot({ profileDir: tempDir('shot-profile-'), output, accountId: 1565, game: GAME, origin: app.origin, exe }), /不覆盖/);
  } finally { app.close(); }
});

test('without a login the picture is not taken and the sign-in page is reported', needBrowser, async () => {
  const app = await fakeApp(false);
  try {
    const output = path.join(tempDir('shot-'), 'creatives.png');
    const result = await listScreenshot({ profileDir: tempDir('shot-profile-'), output, accountId: 1565, game: GAME, origin: app.origin, exe, waitMs: 3_000 });
    assert.equal(result.state, 'login_required');
    assert.equal(fs.existsSync(output), false);
  } finally { app.close(); }
});
