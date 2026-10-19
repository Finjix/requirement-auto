import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FeishuAuth } from '../src/auth.ts';
import { REQUIRED_SCOPES } from '../src/config.ts';
import { BridgeError } from '../src/errors.ts';
import { resolveDataPaths } from '../src/paths.ts';
import { tempDir } from './helpers/tmp.ts';
import { clock } from './helpers/clock.ts';
import { MockFeishu } from './helpers/mock-feishu.ts';

const tmp = () => tempDir('ra-auth-');

async function setup(options: { expectedOpenId?: string; userDir?: string } = {}) {
  const mock = await new MockFeishu().start();
  const userDir = options.userDir ?? tmp();
  const c = clock();
  const auth = new FeishuAuth({
    paths: resolveDataPaths({ LARK_AGENT_USER_DIR: userDir }),
    app: { appId: mock.appId, appSecret: mock.appSecret }, endpoints: mock.endpoints,
    expectedOpenId: options.expectedOpenId, now: c.now, sleep: c.sleep,
  });
  return { mock, auth, c, userDir, done: async () => { await mock.stop(); fs.rmSync(userDir, { recursive: true, force: true }); } };
}

test('login asks for every needed scope plus offline_access, with the app credentials as Basic auth, and a repeat reuses the request', async () => {
  const { mock, auth, done } = await setup();
  try {
    const first = await auth.startLogin();
    assert.equal(first.user_code, 'ABCD-1234');
    assert.match(first.verification_uri_complete, /\/verify\?user_code=ABCD-1234$/);
    assert.equal(first.reused, false);
    const request = mock.requests('/oauth/v1/device_authorization')[0]!;
    const form = new URLSearchParams(request.body);
    assert.equal(form.get('client_id'), mock.appId);
    const scopes = form.get('scope')!.split(' ');
    for (const scope of [...REQUIRED_SCOPES, 'offline_access']) assert.ok(scopes.includes(scope), scope);
    const second = await auth.startLogin();
    assert.equal(second.reused, true);
    assert.equal(mock.requests('/oauth/v1/device_authorization').length, 1);
    // A pending request shows in the status, without anything secret.
    const status = await auth.status();
    assert.equal(status.logged_in, false);
    assert.equal(status.pending_login?.user_code, 'ABCD-1234');
    assert.ok(!JSON.stringify(status).includes('dev-code-1'));
  } finally { await done(); }
});

test('polling waits out authorization_pending, then stores the login; the status never carries a token', async () => {
  const { mock, auth, done } = await setup();
  try {
    await auth.startLogin();
    mock.deviceScript = [{ status: 400, body: { error: 'authorization_pending' } }, { status: 400, body: { error: 'authorization_pending' } }, 'issue'];
    const result = await auth.pollLogin(40_000);
    assert.equal(result.state, 'authorized');
    assert.equal(result.state === 'authorized' && result.open_id, 'ou_alice');
    assert.equal(fs.existsSync(auth.paths.login), false);
    const stored = JSON.parse(fs.readFileSync(auth.paths.auth, 'utf8'));
    assert.equal(stored.open_id, 'ou_alice');
    assert.equal(stored.access_token, mock.currentAccess);
    assert.equal(stored.refresh_token, mock.currentRefresh);
    const status = await auth.status();
    assert.equal(status.logged_in, true);
    assert.equal(status.name, '李小明');
    assert.equal(status.refreshable, true);
    const text = JSON.stringify(status);
    assert.ok(!text.includes(mock.currentAccess) && !text.includes(mock.currentRefresh));
    assert.deepEqual(status.missing_scopes, REQUIRED_SCOPES.filter(item => !mock.scope.split(' ').includes(item)));
  } finally { await done(); }
});

test('slow_down adds five seconds; a short wait returns pending without touching the token endpoint', async () => {
  const { mock, auth, c, done } = await setup();
  try {
    await auth.startLogin();
    mock.deviceScript = [{ status: 400, body: { error: 'slow_down' } }, 'issue'];
    const result = await auth.pollLogin(40_000);
    assert.equal(result.state, 'authorized');
    // interval 1 s, then 1 + 5 s after slow_down
    assert.deepEqual(c.state.slept, [1000, 6000]);

    const other = await setup();
    try {
      other.mock.deviceInterval = 30;
      await other.auth.startLogin();
      const pending = await other.auth.pollLogin(1000);
      assert.equal(pending.state, 'pending');
      assert.equal(other.mock.requests('/oauth/v3/token').length, 0);
    } finally { await other.done(); }
  } finally { await done(); }
});

test('a refusal and an expired request end the pending authorization', async () => {
  const denied = await setup();
  try {
    await denied.auth.startLogin();
    denied.mock.deviceScript = [{ status: 400, body: { error: 'access_denied' } }];
    assert.deepEqual(await denied.auth.pollLogin(10_000), { state: 'denied' });
    assert.equal(fs.existsSync(denied.auth.paths.login), false);
    assert.equal(fs.existsSync(denied.auth.paths.auth), false);
  } finally { await denied.done(); }

  const expired = await setup();
  try {
    await expired.auth.startLogin();
    expired.mock.deviceScript = [{ status: 400, body: { error: 'expired_token' } }];
    assert.deepEqual(await expired.auth.pollLogin(10_000), { state: 'expired' });
    await expired.auth.startLogin();
    expired.c.state.t += 241_000;
    assert.deepEqual(await expired.auth.pollLogin(10_000), { state: 'expired' });
  } finally { await expired.done(); }
});

test('a login of somebody else than the user this process serves is refused and nothing is stored', async () => {
  const { mock, auth, done } = await setup({ expectedOpenId: 'ou_bob' });
  try {
    await auth.startLogin();
    mock.deviceScript = ['issue'];
    await assert.rejects(() => auth.pollLogin(10_000), (e: BridgeError) => e.kind === 'identity_mismatch');
    assert.equal(fs.existsSync(auth.paths.auth), false);
    assert.equal(fs.existsSync(auth.paths.login), false);
  } finally { await done(); }
});

test('a stored login that belongs to another user is not used', async () => {
  const { mock, auth, userDir, done } = await setup();
  try {
    await auth.startLogin();
    mock.deviceScript = ['issue'];
    await auth.pollLogin(10_000);
    const intruder = new FeishuAuth({ paths: auth.paths, app: { appId: mock.appId, appSecret: mock.appSecret }, endpoints: mock.endpoints, expectedOpenId: 'ou_bob' });
    await assert.rejects(() => intruder.accessToken(), (e: BridgeError) => e.kind === 'identity_mismatch');
    await assert.rejects(() => intruder.status(), (e: BridgeError) => e.kind === 'identity_mismatch');
    assert.ok(fs.existsSync(path.join(userDir, 'requirement-auto', 'feishu', 'auth.json')));
  } finally { await done(); }
});

test('the access token is renewed shortly before it ends, the refresh token rotates, and a second call needs no renewal', async () => {
  const { mock, auth, c, done } = await setup();
  try {
    await auth.startLogin();
    mock.deviceScript = ['issue'];
    await auth.pollLogin(10_000);
    const first = mock.currentAccess;
    assert.equal(await auth.accessToken(), first);
    assert.equal(mock.refreshCount, 0);
    c.state.t += (7200 - 200) * 1000; // inside the five-minute margin
    const renewed = await auth.accessToken();
    assert.notEqual(renewed, first);
    assert.equal(renewed, mock.currentAccess);
    assert.equal(mock.refreshCount, 1);
    assert.equal(JSON.parse(fs.readFileSync(auth.paths.auth, 'utf8')).refresh_token, mock.currentRefresh);
    assert.equal(await auth.accessToken(), renewed);
    assert.equal(mock.refreshCount, 1);
  } finally { await done(); }
});

test('a refresh token the server no longer accepts ends the login; an unreachable server does not', async () => {
  const { mock, auth, c, done } = await setup();
  try {
    await auth.startLogin();
    mock.deviceScript = ['issue'];
    await auth.pollLogin(10_000);
    c.state.t += 7_100_000;
    await mock.stop(); // nobody to answer
    await assert.rejects(() => auth.accessToken(), (e: BridgeError) => e.kind === 'network');
    assert.ok(fs.existsSync(auth.paths.auth), 'the login survives a failed attempt to reach Feishu');
    await mock.start();
    const stored = JSON.parse(fs.readFileSync(auth.paths.auth, 'utf8'));
    stored.refresh_token = 'ur-already-used';
    fs.writeFileSync(auth.paths.auth, JSON.stringify(stored));
    const second = new FeishuAuth({ paths: auth.paths, app: { appId: mock.appId, appSecret: mock.appSecret }, endpoints: mock.endpoints, now: c.now, sleep: c.sleep });
    await assert.rejects(() => second.accessToken(), (e: BridgeError) => e.kind === 'auth_required');
    assert.equal(fs.existsSync(auth.paths.auth), false);
  } finally { await done(); }
});

test('without a refresh token the login is good for the access token alone and then asks again', async () => {
  const { mock, auth, c, done } = await setup();
  try {
    mock.withRefreshToken = false;
    await auth.startLogin();
    mock.deviceScript = ['issue'];
    const result = await auth.pollLogin(10_000);
    assert.equal(result.state === 'authorized' && result.refreshable, false);
    assert.equal((await auth.status()).refreshable, false);
    c.state.t += 7_300_000;
    assert.equal((await auth.status()).logged_in, false);
    await assert.rejects(() => auth.accessToken(), (e: BridgeError) => e.kind === 'auth_required');
  } finally { await done(); }
});

test('logging out removes the stored login and the pending request', async () => {
  const { mock, auth, done } = await setup();
  try {
    await auth.startLogin();
    mock.deviceScript = ['issue'];
    await auth.pollLogin(10_000);
    await auth.startLogin().catch(() => {});
    await auth.logout();
    assert.equal(fs.existsSync(auth.paths.auth), false);
    assert.equal(fs.existsSync(auth.paths.login), false);
    assert.equal((await auth.status()).logged_in, false);
  } finally { await done(); }
});

test('wrong app credentials are reported as a configuration problem', async () => {
  const { mock, done } = await setup();
  try {
    const auth = new FeishuAuth({ paths: resolveDataPaths({ LARK_AGENT_USER_DIR: tmp() }), app: { appId: mock.appId, appSecret: 'wrong-secret-0000' }, endpoints: mock.endpoints });
    await assert.rejects(() => auth.startLogin(), (e: BridgeError) => e.kind === 'config');
  } finally { await done(); }
});
