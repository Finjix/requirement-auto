import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FeishuAuth } from '../src/auth.ts';
import { loadApp } from '../src/config.ts';
import { withLock } from '../src/fsutil.ts';
import { resolveDataPaths } from '../src/paths.ts';
import { draftIdOf } from '../src/gof/cls-adapter.ts';
import { checkPin, pinState } from '../src/gof/cls-guard.ts';
import { accountNames, checkToken } from '../src/gof/cls-session.ts';
import { Blocked, writeJsonNew } from '../src/gof/util.ts';
import { clock } from './helpers/clock.ts';
import { MockFeishu } from './helpers/mock-feishu.ts';
import { tempDir } from './helpers/tmp.ts';

test('an unreadable account pin is a refusal, never "no pin yet"', () => {
  const dir = tempDir('ra-pin-');
  const file = path.join(dir, 'account.json');
  assert.deepEqual(pinState(file), { state: 'none' });
  for (const text of ['', '{"id":', '{"id":"7"}', 'null']) {
    fs.writeFileSync(file, text);
    assert.equal(pinState(file).state, 'corrupt', text);
    assert.throws(() => checkPin(file, { id: 7, name: '张三' }), (error: Error) => error instanceof Blocked && /损坏/.test(error.message), text);
    assert.equal(fs.readFileSync(file, 'utf8'), text, 'the file is left for an administrator');
  }
  fs.writeFileSync(file, '{"id":7,"name":"张三","pinned_at":"x"}');
  assert.equal(pinState(file).state, 'ok');
  checkPin(file, { id: 7, name: '张三' });
});

test('the CLS server saying no is told apart from not being able to ask', async () => {
  const answer = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  const good = { code: 0, data: { id: 7, name: '张三', status: 1 } };
  assert.deepEqual(await checkToken('http://x', 'Bearer a', answer(200, good)), { account: { id: 7, name: '张三' } });
  assert.deepEqual(await checkToken('http://x', 'Bearer a', answer(401, { code: 401 })), { rejected: true });
  assert.deepEqual(await checkToken('http://x', 'Bearer a', answer(200, { code: 0, data: { id: 7, status: 0 } })), { rejected: true });
  assert.deepEqual(await checkToken('http://x', 'Bearer a', answer(200, null)), { rejected: true });
  for (const status of [502, 503, 429]) assert.deepEqual(await checkToken('http://x', 'Bearer a', answer(status, {})), { unreachable: true }, String(status));
  assert.deepEqual(await checkToken('http://x', 'Bearer a', (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch), { unreachable: true });
});

test('the consent page may show the company name or one part of "name（alias）"', () => {
  assert.deepEqual(accountNames('张三'), ['张三']);
  assert.deepEqual(accountNames('张三（Zhang San）').sort(), ['Zhang San', '张三', '张三（Zhang San）'].sort());
  assert.deepEqual(accountNames('A'), [], 'one character would match anything');
});

test('a save response gives its draft ID as a number or digits, at the top or under script; anything else is not an ID', () => {
  assert.equal(draftIdOf({ id: 12 }), 12);
  assert.equal(draftIdOf({ id: '12' }), 12);
  assert.equal(draftIdOf({ script: { id: 5 } }), 5);
  for (const bad of [undefined, null, {}, { id: 0 }, { id: -1 }, { id: '1e3' }, { id: 1.5 }, { id: 'x' }]) assert.equal(draftIdOf(bad), undefined, JSON.stringify(bad));
});

test('files are created exclusively and never half-made', () => {
  const dir = tempDir('ra-new-');
  const file = path.join(dir, 'a.json');
  writeJsonNew(file, { a: 1 });
  assert.throws(() => writeJsonNew(file, { a: 2 }), /EEXIST/);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { a: 1 });
  assert.deepEqual(fs.readdirSync(dir), ['a.json'], 'no side file is left, after success or after a refusal');
});

test('an app.json written with a byte order mark is read', () => {
  const dir = tempDir('ra-app-');
  fs.writeFileSync(path.join(dir, 'app.json'), '﻿{"appId":"cli_x","appSecret":"s"}');
  const app = loadApp({}, { mode: 'standalone', root: dir } as any);
  assert.equal(app.appId, 'cli_x');
});

test('a lock holder that was taken over does not remove the lock of whoever has it now', async () => {
  const dir = tempDir('ra-lock-');
  const file = path.join(dir, 'x.lock');
  await withLock(file, async () => {
    fs.rmSync(file); // taken over as stale ...
    fs.writeFileSync(file, JSON.stringify({ pid: 1, at: Date.now(), owner: 'somebody-else' })); // ... and held by another process
  });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).owner, 'somebody-else');
  fs.rmSync(file);
  await withLock(file, async () => { assert.ok(fs.existsSync(file)); });
  assert.ok(!fs.existsSync(file), 'its own lock is released');
});

async function authSetup(options: { refresh?: boolean } = {}) {
  const mock = await new MockFeishu().start();
  mock.withRefreshToken = options.refresh ?? true;
  const userDir = tempDir('ra-auth2-');
  const c = clock();
  const auth = new FeishuAuth({
    paths: resolveDataPaths({ LARK_AGENT_USER_DIR: userDir }),
    app: { appId: mock.appId, appSecret: mock.appSecret }, endpoints: mock.endpoints, now: c.now, sleep: c.sleep,
  });
  return { mock, auth, c, done: async () => { await mock.stop(); fs.rmSync(userDir, { recursive: true, force: true }); } };
}

test('a gateway error while the user is confirming does not cost them the authorization', async () => {
  const { mock, auth, done } = await authSetup();
  try {
    await auth.startLogin();
    mock.deviceScript = [{ status: 502, body: {} }, { status: 429, body: { code: 99 } }, 'issue'];
    const result = await auth.pollLogin(60_000);
    assert.equal(result.state, 'authorized');
  } finally { await done(); }
});

test('a login without a refresh token stays until its access token really ends', async () => {
  const { mock, auth, c, done } = await authSetup({ refresh: false });
  try {
    await auth.startLogin();
    mock.deviceScript = ['issue'];
    assert.equal((await auth.pollLogin(40_000)).state, 'authorized');
    const first = await auth.accessToken();
    c.state.t += (7200 - 120) * 1000; // inside the renewal margin, still valid
    assert.equal(await auth.accessToken(), first);
    assert.ok(fs.existsSync(auth.paths.auth), 'the login is not deleted early');
    c.state.t += 200 * 1000; // now it has ended
    await assert.rejects(auth.accessToken(), /已过期/);
    assert.ok(!fs.existsSync(auth.paths.auth));
  } finally { await done(); }
});
