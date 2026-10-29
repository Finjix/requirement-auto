import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepare, record, report } from '../src/gof/batch.ts';
import { main } from '../src/gof/cli.ts';
import type { Online } from '../src/gof/cls-online.ts';
import { findBrowser } from '../src/gof/chromium.ts';
import { draftScreenshot } from '../src/gof/draft-shot.ts';
import { makePlan } from '../src/gof/plan.ts';
import { locatedUrl, sheetScreenshot } from '../src/gof/sheet-shot.ts';
import { sheetPicture } from '../src/gof/shots-online.ts';
import { Snapshot } from '../src/gof/snapshot.ts';
import { readJson } from '../src/gof/util.ts';
import { GAME } from './helpers/fake-creative.ts';
import { tempDir } from './helpers/tmp.ts';

const exe = findBrowser();
const needBrowser = exe ? {} : { skip: 'no Chrome or Edge on this machine' };
const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const isPng = (file: string) => assert.deepEqual([...fs.readFileSync(file).subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], 'a PNG');

type Server = { origin: string; seen: string[]; close: () => void };
function serve(handler: (url: URL, send: (type: string, body: string) => void) => boolean | void): Promise<Server> {
  const seen: string[] = [];
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://x');
    seen.push(`${url.pathname}${url.search}`);
    const send = (type: string, body: string) => { response.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` }); response.end(body); };
    if (handler(url, send) === false) { response.writeHead(404); response.end(); }
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () =>
    resolve({ origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, close: () => { server.closeAllConnections(); server.close(); } })));
}

/** The progress sheet as far as the picture needs it: a page with a drawing surface; `signedIn: false` sends to the sign-in page. */
const fakeSheet = (signedIn = true) => serve((url, send) => {
  if (url.pathname.startsWith('/wiki/')) {
    return signedIn ? send('text/html', '<!doctype html><body><canvas width="600" height="300" style="background:#cde"></canvas></body>')
      : send('text/html', '<script>location.replace("/accounts/page/login")</script>');
  }
  if (url.pathname === '/accounts/page/login') return send('text/html', '<p>扫码登录</p>');
  return false;
});

const rangeAsked = (app: Server): string => {
  const asked = new URL(app.seen.find(s => s.startsWith('/wiki/'))!, 'http://x');
  return Buffer.from(asked.searchParams.get('range')!, 'base64').toString('utf8');
};

test('the sheet link names the appended rows the way Feishu’s own range link does', () => {
  const parsed = new URL(locatedUrl('https://centurygames.feishu.cn/wiki/NODE?sheet=abc123', 'A120:AB131'));
  assert.equal(parsed.searchParams.get('sheet'), 'abc123');
  assert.equal(Buffer.from(parsed.searchParams.get('range')!, 'base64').toString('utf8'), 'A120:AB131');
  assert.equal(locatedUrl('https://centurygames.feishu.cn/wiki/NODE?sheet=abc123', undefined), 'https://centurygames.feishu.cn/wiki/NODE?sheet=abc123');
});

test('the progress sheet picture opens the sheet on the appended rows and never overwrites a file', needBrowser, async () => {
  const app = await fakeSheet();
  try {
    const output = path.join(tempDir('sheet-shot-'), 'progress.png');
    const url = `${app.origin}/wiki/NODE?sheet=abc123`;
    const result = await sheetScreenshot({ profileDir: tempDir('sheet-profile-'), output, url, range: 'A120:AB131', exe, waitMs: 15_000 });
    assert.equal(result.state, 'ok', JSON.stringify(result));
    isPng(output);
    assert.equal(rangeAsked(app), 'A120:AB131');
    await assert.rejects(sheetScreenshot({ profileDir: tempDir('sheet-profile-'), output, url, exe }), /不覆盖/);
  } finally { app.close(); }
});

test('without a Feishu web login the sheet picture is not taken and the sign-in page is reported', needBrowser, async () => {
  const app = await fakeSheet(false);
  try {
    const output = path.join(tempDir('sheet-shot-'), 'progress.png');
    const result = await sheetScreenshot({ profileDir: tempDir('sheet-profile-'), output, url: `${app.origin}/wiki/NODE?sheet=abc123`, exe, waitMs: 8_000 });
    assert.equal(result.state, 'login_required', JSON.stringify(result));
    assert.equal(fs.existsSync(output), false);
  } finally { app.close(); }
});

/** The CLS app as far as the draft picture needs it: it asks who is logged in, keeps its game, and its router draws the draft page (or lands elsewhere). */
function fakeApp(landsAt?: string) {
  const page = `<!doctype html><body><div id="app"></div><script>
    fetch('/api/userinfo', { headers: { Authorization: 'Bearer good' } }).then(() => {
      window.DD_VUE_INSTANCE = { $router: { push: async (to) => {
        const game = JSON.parse(localStorage.getItem('DD-CLS-GLOBAL-CURGAME') || '{}');
        const landed = ${JSON.stringify(landsAt ?? null)} || to;
        history.pushState({}, '', landed);
        if (landed !== to) { document.getElementById('app').innerText = '无权限'; return; }
        const r = await fetch('/api/workflow/script/5001?game_id=' + game.id);
        const { data } = await r.json();
        document.getElementById('app').innerHTML = '<h1>' + data.script.name + '</h1><p>脚本 ' + data.script.sub_scripts.length + ' 条</p>';
      } } };
    });
  </script></body>`;
  return serve((url, send) => {
    if (url.pathname === '/requirements') return send('text/html', page);
    if (url.pathname === '/api/userinfo') return send('application/json', JSON.stringify({ code: 0, data: { id: 1565, status: 1 } }));
    if (url.pathname === '/api/workflow/script/5001') {
      return send('application/json', JSON.stringify({ code: 0, data: { script: { id: 5001, name: 'GOFCN66001-GOFCN66002', sub_scripts: [{}, {}] } } }));
    }
    return false;
  });
}

test('the draft picture opens the draft in the app for GOFCN and never overwrites a file', needBrowser, async () => {
  const app = await fakeApp();
  try {
    const output = path.join(tempDir('draft-shot-'), 'draft.png');
    const result = await draftScreenshot({ profileDir: tempDir('draft-profile-'), output, draftId: 5001, game: GAME, origin: app.origin, exe, waitMs: 15_000 });
    assert.equal(result.state, 'ok', JSON.stringify(result));
    isPng(output);
    assert.ok(app.seen.includes('/api/workflow/script/5001?game_id=94'), `the draft was asked for in GOFCN: ${app.seen.join(' ')}`);
    await assert.rejects(draftScreenshot({ profileDir: tempDir('draft-profile-'), output, draftId: 5001, game: GAME, origin: app.origin, exe }), /不覆盖/);
  } finally { app.close(); }
});

test('a draft page the app turns away is reported and no picture is written', needBrowser, async () => {
  const app = await fakeApp('/no-permission');
  try {
    const output = path.join(tempDir('draft-shot-'), 'draft.png');
    const result = await draftScreenshot({ profileDir: tempDir('draft-profile-'), output, draftId: 5001, game: GAME, origin: app.origin, exe, waitMs: 10_000 });
    assert.equal(result.state, 'no_access', JSON.stringify(result));
    assert.equal(fs.existsSync(output), false);
  } finally { app.close(); }
});

const online: Online = { session: async () => ({ authorization: 'Bearer good', account: { id: 7, name: '张三' }, origin: 'http://127.0.0.1:1' }), capture: async () => ({ state: 'login_required' }) };

function newBatch(): string {
  const base = new Snapshot(path.join(fixtures, 'base.xlsx'));
  return prepare(makePlan(base, readJson(path.join(fixtures, 'requests', 'basic.json'))), base, { outputRoot: tempDir('shots-batch-') }).batch as string;
}

test('the batch decides what is photographed: no picture before the rows are appended, none of a draft that does not exist', async () => {
  const dir = newBatch();
  const output = path.join(dir, 'progress.png');
  const early = await main(['feishu', 'screenshot', '--batch', dir, '--output', output], undefined, online);
  assert.equal(early.code, 2);
  assert.match(early.result.reason, /还没有追加并验收/);
  const noDraft = await main(['cls', 'screenshot', '--batch', dir, '--output', path.join(dir, 'draft.png')], undefined, online);
  assert.equal(noDraft.code, 2);
  assert.match(noDraft.result.reason, /还没有保存任何 CLS 草稿/);
  assert.equal(fs.existsSync(output), false);
});

test('after the append the sheet picture is taken on the batch’s rows', needBrowser, async () => {
  const dir = newBatch();
  record(dir, 'append_started', null);
  record(dir, 'append_verified', null, {}, new Snapshot(path.join(fixtures, 'applied-complete.xlsx')));
  const app = await fakeSheet();
  try {
    const output = path.join(tempDir('sheet-shot-'), 'progress.png');
    const range = report(dir).range as string;
    const result = await sheetPicture(online, dir, output, { sheet: { url: `${app.origin}/wiki/NODE?sheet=abc`, profileDir: tempDir('sheet-profile-'), exe, waitMs: 15_000 } });
    assert.equal(result.status, 'screenshot_saved');
    assert.equal(result.range, range);
    isPng(output);
    assert.equal(rangeAsked(app), range);
  } finally { app.close(); }
});
