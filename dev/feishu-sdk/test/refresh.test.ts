import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { FeishuAuth } from '../src/auth.ts';
import { withLock } from '../src/fsutil.ts';
import { resolveDataPaths } from '../src/paths.ts';
import { tempDir } from './helpers/tmp.ts';
import { MockFeishu } from './helpers/mock-feishu.ts';

const run = promisify(execFile);
const worker = path.join(import.meta.dirname, 'helpers', 'refresh-worker.ts');

test('several processes needing a renewal at the same moment cause one refresh and all get the new token', async () => {
  const mock = await new MockFeishu().start();
  const dir = tempDir('ra-race-');
  try {
    const auth = new FeishuAuth({ paths: resolveDataPaths({ LARK_AGENT_USER_DIR: dir }), app: { appId: mock.appId, appSecret: mock.appSecret }, endpoints: mock.endpoints });
    await auth.startLogin();
    mock.deviceScript = ['issue'];
    await auth.pollLogin(10_000);
    const stale = mock.currentAccess;
    mock.refreshDelayMs = 300; // keeps the first refresh in flight while the others arrive

    // Each child believes it is six hours later, so the stored access token is due for renewal in all of them.
    const env = { ...process.env, MOCK_URL: mock.url, MOCK_APP_ID: mock.appId, MOCK_APP_SECRET: mock.appSecret, LARK_AGENT_USER_DIR: dir, FAKE_NOW: String(6 * 3600 * 1000) };
    const results = await Promise.all(Array.from({ length: 4 }, () => run(process.execPath, [worker], { env, encoding: 'utf8' })));
    const replies = results.map(result => JSON.parse(result.stdout));
    assert.ok(replies.every(reply => reply.ok), JSON.stringify(replies));
    assert.equal(mock.refreshCount, 1, 'the single-use refresh token was spent once');
    assert.equal(new Set(replies.map(reply => reply.token)).size, 1);
    assert.notEqual(replies[0].token, stale);
    assert.equal(replies[0].token, mock.currentAccess);
    assert.equal(JSON.parse(fs.readFileSync(auth.paths.auth, 'utf8')).refresh_token, mock.currentRefresh);
  } finally {
    await mock.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the lock is exclusive, released after use, and a dead one is taken over', async () => {
  const dir = tempDir('ra-lock-');
  const file = path.join(dir, 'x.lock');
  try {
    const order: string[] = [];
    await Promise.all([
      withLock(file, async () => { order.push('a-in'); await new Promise(resolve => setTimeout(resolve, 80)); order.push('a-out'); }),
      withLock(file, async () => { order.push('b-in'); order.push('b-out'); }),
    ]);
    assert.deepEqual(order.map(item => item.slice(2)), ['in', 'out', 'in', 'out']);
    assert.equal(fs.existsSync(file), false);

    fs.writeFileSync(file, '{"pid":0}');
    const old = new Date(Date.now() - 120_000);
    fs.utimesSync(file, old, old);
    assert.equal(await withLock(file, async () => 'took over', { staleMs: 1000 }), 'took over');

    fs.writeFileSync(file, '{"pid":0}');
    await assert.rejects(() => withLock(file, async () => 'never', { timeoutMs: 150, staleMs: 60_000 }), (e: { kind?: string }) => e.kind === 'network');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
