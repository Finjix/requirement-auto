import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FeishuAuth } from '../src/auth.ts';
import { BridgeError } from '../src/errors.ts';
import { expectedOpenId, resolveDataPaths } from '../src/paths.ts';
import { runBridge } from '../src/bridge.ts';
import { tempDir } from './helpers/tmp.ts';
import { clock } from './helpers/clock.ts';
import { MockFeishu } from './helpers/mock-feishu.ts';

const tmp = () => tempDir('ra-iso-');

async function login(mock: MockFeishu, userDir: string, openId: string) {
  mock.openId = openId;
  const c = clock();
  const auth = new FeishuAuth({
    paths: resolveDataPaths({ LARK_AGENT_USER_DIR: userDir }), app: { appId: mock.appId, appSecret: mock.appSecret },
    endpoints: mock.endpoints, expectedOpenId: openId, now: c.now, sleep: c.sleep,
  });
  await auth.startLogin();
  mock.deviceScript = ['issue'];
  const result = await auth.pollLogin(10_000);
  assert.equal(result.state, 'authorized');
  return auth;
}

test('two users on one machine keep separate logins in their own directories', async () => {
  const mock = await new MockFeishu().start();
  const aliceDir = tmp(), bobDir = tmp();
  try {
    const alice = await login(mock, aliceDir, 'ou_alice');
    const aliceToken = mock.currentAccess;
    const bob = await login(mock, bobDir, 'ou_bob');
    const bobToken = mock.currentAccess;
    assert.notEqual(aliceToken, bobToken);

    const aliceFile = JSON.parse(fs.readFileSync(path.join(aliceDir, 'requirement-auto', 'feishu', 'auth.json'), 'utf8'));
    const bobFile = JSON.parse(fs.readFileSync(path.join(bobDir, 'requirement-auto', 'feishu', 'auth.json'), 'utf8'));
    assert.equal(aliceFile.open_id, 'ou_alice');
    assert.equal(aliceFile.access_token, aliceToken);
    assert.equal(bobFile.open_id, 'ou_bob');
    assert.equal(bobFile.access_token, bobToken);
    assert.equal((await alice.status()).open_id, 'ou_alice');
    assert.equal((await bob.status()).open_id, 'ou_bob');

    await alice.logout();
    assert.equal((await alice.status()).logged_in, false);
    assert.equal((await bob.status()).logged_in, true, 'logging out one user leaves the other logged in');
    assert.ok(!fs.existsSync(path.join(aliceDir, 'requirement-auto', 'feishu', 'auth.json')));
  } finally {
    await mock.stop();
    fs.rmSync(aliceDir, { recursive: true, force: true });
    fs.rmSync(bobDir, { recursive: true, force: true });
  }
});

test('the data directory comes from the host environment only, and only as a safe absolute path', () => {
  const dir = tmp();
  try {
    const host = resolveDataPaths({ LARK_AGENT_USER_DIR: dir });
    assert.equal(host.mode, 'host');
    assert.equal(host.root, path.join(dir, 'requirement-auto'));
    assert.equal(host.auth, path.join(dir, 'requirement-auto', 'feishu', 'auth.json'));
    assert.equal(host.batches, path.join(dir, 'requirement-auto', 'batches'));
    // A path with .. is normalised, not followed out of the user's directory by a later join.
    assert.equal(resolveDataPaths({ LARK_AGENT_USER_DIR: path.join(dir, 'a', '..', 'b') }).root, path.join(dir, 'b', 'requirement-auto'));
    assert.throws(() => resolveDataPaths({ LARK_AGENT_USER_DIR: 'user/alice' }), (e: BridgeError) => e.kind === 'config');
    assert.throws(() => resolveDataPaths({ LARK_AGENT_USER_DIR: path.parse(dir).root }), (e: BridgeError) => e.kind === 'config');
    assert.throws(() => resolveDataPaths({ LARK_AGENT_USER_DIR: `${dir}\0x` }), (e: BridgeError) => e.kind === 'config');
    // The host variable wins over the plugin data directory, which wins over the home fallback.
    assert.equal(resolveDataPaths({ PLUGIN_DATA: dir }).mode, 'plugin-data');
    assert.equal(resolveDataPaths({ PLUGIN_DATA: dir, LARK_AGENT_USER_DIR: dir }).mode, 'host');
    assert.equal(resolveDataPaths({}, dir).root, path.join(dir, '.requirement-auto', 'default'));
    assert.equal(expectedOpenId({ LARK_AGENT_USER_OPEN_ID: 'ou_abc123' }), 'ou_abc123');
    assert.equal(expectedOpenId({}), undefined);
    assert.throws(() => expectedOpenId({ LARK_AGENT_USER_OPEN_ID: '../ou' }), (e: BridgeError) => e.kind === 'config');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('bridge commands cannot name another user: the user is whoever the environment says', async () => {
  const mock = await new MockFeishu().start();
  const aliceDir = tmp(), bobDir = tmp();
  try {
    await login(mock, aliceDir, 'ou_alice');
    const asBob = { env: { LARK_AGENT_USER_DIR: bobDir, FEISHU_APP_ID: mock.appId, FEISHU_APP_SECRET: mock.appSecret }, endpoints: mock.endpoints };
    // Extra fields that look like an identity are simply not read.
    const status = await runBridge('auth-status', { user_dir: aliceDir, open_id: 'ou_alice', LARK_AGENT_USER_DIR: aliceDir }, asBob);
    assert.deepEqual(status, { ok: true, data: { logged_in: false, app_configured: true, storage: 'host' } });
    const read = await runBridge('api-get', { path: '/open-apis/wiki/v2/spaces/get_node', params: { token: 'x' }, user_dir: aliceDir }, asBob);
    assert.equal(read.ok, false);
    assert.equal(!read.ok && read.error.kind, 'auth_required');
  } finally {
    await mock.stop();
    fs.rmSync(aliceDir, { recursive: true, force: true });
    fs.rmSync(bobDir, { recursive: true, force: true });
  }
});

test('error text that leaves the bridge never contains the app secret or a token', async () => {
  const mock = await new MockFeishu().start();
  const dir = tmp();
  try {
    const auth = await login(mock, dir, 'ou_alice');
    const env = { LARK_AGENT_USER_DIR: dir, FEISHU_APP_ID: mock.appId, FEISHU_APP_SECRET: mock.appSecret };
    mock.writeReply = { status: 200, body: { code: 1, msg: `boom ${mock.appSecret} Bearer ${mock.currentAccess} ${mock.currentRefresh}` } };
    const reply = await runBridge('sheets-cells-set', {
      token: 'shtABCDEFGH', writes: [{ sheet_id: 's1', range: 'A1:A1', cells: [[{ value: 'x' }]], allow_overwrite: false }],
    }, { env, endpoints: mock.endpoints });
    const text = JSON.stringify(reply);
    assert.equal(reply.ok, false);
    assert.ok(!text.includes(mock.appSecret) && !text.includes(mock.currentAccess) && !text.includes(mock.currentRefresh), text);
    void auth;
  } finally {
    await mock.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
