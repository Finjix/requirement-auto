import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { FeishuAuth } from '../src/auth.ts';
import { runBridge, type BridgeReply } from '../src/bridge.ts';
import { main } from '../src/gof/cli.ts';
import type { Online } from '../src/gof/cls-online.ts';
import type { Capture } from '../src/gof/cls-session.ts';
import { Bridge } from '../src/gof/feishu.ts';
import { resolveDataPaths } from '../src/paths.ts';
import { REQUIRED_SCOPES } from '../src/config.ts';
import { clock } from './helpers/clock.ts';
import { MockFeishu } from './helpers/mock-feishu.ts';
import { tempDir } from './helpers/tmp.ts';

type Obj = Record<string, any>;

/** A user who has logged in through the device flow, and the environment a bridge command for them runs in. */
async function loggedIn(mock: MockFeishu, dir: string, extraEnv: Record<string, string> = {}) {
  const c = clock(Date.now());
  const auth = new FeishuAuth({ paths: resolveDataPaths({ LARK_AGENT_USER_DIR: dir }), app: { appId: mock.appId, appSecret: mock.appSecret }, endpoints: mock.endpoints, now: c.now, sleep: c.sleep });
  await auth.startLogin();
  mock.deviceScript = ['issue'];
  await auth.pollLogin(10_000);
  return { env: { LARK_AGENT_USER_DIR: dir, FEISHU_APP_ID: mock.appId, FEISHU_APP_SECRET: mock.appSecret, ...extraEnv }, endpoints: mock.endpoints };
}

const verify = (ctx: { env: Record<string, string>; endpoints: MockFeishu['endpoints'] }) => runBridge('auth-verify', undefined, ctx);

test('the Feishu check asks Feishu with the stored login, and a good login is reported with who it is', async () => {
  const mock = await new MockFeishu().start();
  const dir = tempDir('ra-chk-');
  try {
    mock.scope = [...REQUIRED_SCOPES, 'offline_access'].join(' ');
    const ctx = await loggedIn(mock, dir);
    const before = mock.requests('/open-apis/authen/v1/user_info').length;
    const reply = await verify(ctx);
    assert.equal(reply.ok, true);
    const data = (reply as { data: Obj }).data;
    assert.deepEqual([data.logged_in, data.open_id, data.name, data.missing_scopes], [true, 'ou_alice', '李小明', []]);
    assert.equal(mock.requests('/open-apis/authen/v1/user_info').length, before + 1, 'Feishu was asked, not the local file');
    assert.ok(!JSON.stringify(reply).includes(mock.currentAccess), 'no token in the reply');
  } finally { await mock.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a login Feishu no longer accepts is found by the check: renewed when it can be, reported when it cannot', async () => {
  const mock = await new MockFeishu().start();
  const dir = tempDir('ra-chk-');
  try {
    mock.scope = [...REQUIRED_SCOPES, 'offline_access'].join(' ');
    const ctx = await loggedIn(mock, dir);

    // The access token was forgotten but the refresh token is good: the check renews the login and passes.
    mock.revokeAccess();
    const refreshed = mock.refreshCount;
    assert.equal((await verify(ctx)).ok, true);
    assert.equal(mock.refreshCount, refreshed + 1);

    // The user withdrew the authorization: both are gone. The local file still says "logged in" until Feishu is asked.
    const status = await runBridge('auth-status', undefined, ctx);
    assert.equal((status as { data: Obj }).data.logged_in, true, 'the local record alone would have passed');
    mock.revokeAll();
    const dead = await verify(ctx);
    assert.equal(!dead.ok && dead.error.kind, 'auth_required');
    const after = await runBridge('auth-status', undefined, ctx);
    assert.equal((after as { data: Obj }).data.logged_in, false, 'and the dead login is dropped, so nothing keeps trying it');
  } finally { await mock.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the Feishu check reports no login, the wrong person, missing permissions and an unreachable Feishu as what they are', async () => {
  const mock = await new MockFeishu().start();
  const dir = tempDir('ra-chk-');
  try {
    const none = await verify({ env: { LARK_AGENT_USER_DIR: tempDir('ra-chk-none-'), FEISHU_APP_ID: mock.appId, FEISHU_APP_SECRET: mock.appSecret }, endpoints: mock.endpoints });
    assert.equal(!none.ok && none.error.kind, 'auth_required');

    mock.scope = [...REQUIRED_SCOPES.slice(0, 3), 'offline_access'].join(' ');
    const ctx = await loggedIn(mock, dir);
    const partial = await verify(ctx);
    assert.equal(partial.ok, true);
    assert.deepEqual((partial as { data: Obj }).data.missing_scopes, REQUIRED_SCOPES.slice(3));

    // The host says this process serves somebody else than the saved login belongs to.
    const other = await verify({ ...ctx, env: { ...ctx.env, LARK_AGENT_USER_OPEN_ID: 'ou_bob' } });
    assert.equal(!other.ok && other.error.kind, 'identity_mismatch');

    await mock.stop();
    const down = await verify(ctx);
    assert.equal(!down.ok && down.error.kind, 'network');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- the command that checks both ------------------------------------------------------------------------------------------------

const ok = (data: Obj): BridgeReply => ({ ok: true, data });
const fail = (kind: string, message = '消息'): BridgeReply => ({ ok: false, error: { kind, message } }) as BridgeReply;
const account = { id: 7, name: '张三' };

function bridgeSaying(reply: BridgeReply): Bridge {
  return new Bridge(async () => reply);
}

function clsSaying(state: Capture['state'] | 'pin', extra: Obj = {}): Online & { looked: number } {
  const online = {
    looked: 0,
    session: async () => { throw new Error('not used'); },
    capture: async () => {
      online.looked++;
      if (state === 'pin') throw new (await import('../src/gof/util.ts')).Blocked('这个用户的 CLS 账号已绑定为“张三”，这次登录的是另一个账号，已拒绝。');
      return { state, authorization: 'secret-token-1', account, ...extra } as Capture;
    },
    loginQr: async () => { throw new Error('a check must never start a login'); },
  };
  return online;
}

const goodFeishu = ok({ logged_in: true, open_id: 'ou_alice', name: '李小明', missing_scopes: [], refresh_expires_at: 1 });

test('login check: both good is ok; each missing login is named with what to do about it; nothing is started', async () => {
  const good = clsSaying('ok');
  const both = await main(['login', 'check'], bridgeSaying(goodFeishu), good);
  assert.deepEqual([both.code, both.result.status, both.result.feishu.status, both.result.cls.status, both.result.todo], [0, 'ok', 'ok', 'ok', undefined]);
  assert.deepEqual(both.result.cls.account, account);

  const clsNotLooked = clsSaying('ok');
  const feishuGone = await main(['login', 'check'], bridgeSaying(fail('auth_required', '飞书登录已失效')), clsNotLooked);
  assert.deepEqual([feishuGone.code, feishuGone.result.status, feishuGone.result.feishu.status], [2, 'login_required', 'login_required']);
  assert.equal(feishuGone.result.todo.length, 1);
  assert.match(feishuGone.result.todo[0], /feishu login start/);
  assert.equal(feishuGone.result.cls.status, 'not_checked', 'CLS waits for Feishu');
  assert.equal(clsNotLooked.looked, 0, 'no browser is started while Feishu is not logged in');

  const clsGone = await main(['login', 'check'], bridgeSaying(goodFeishu), clsSaying('login_required'));
  assert.deepEqual([clsGone.code, clsGone.result.status, clsGone.result.cls.status], [2, 'login_required', 'login_required']);
  assert.match(clsGone.result.todo[0], /cls login --qr/);

  const neitherCls = clsSaying('login_required');
  const neither = await main(['login', 'check'], bridgeSaying(fail('auth_required')), neitherCls);
  assert.equal(neither.result.todo.length, 1, 'one login at a time: Feishu first');
  assert.match(neither.result.todo[0], /feishu login start/);
  assert.equal(neitherCls.looked, 0);

  const missingScopes = await main(['login', 'check'], bridgeSaying(ok({ logged_in: true, name: '李小明', missing_scopes: ['wiki:wiki:readonly'] })), clsSaying('ok'));
  assert.deepEqual([missingScopes.result.status, missingScopes.result.feishu.status, missingScopes.result.feishu.missing_scopes], ['login_required', 'scopes_missing', ['wiki:wiki:readonly']]);
  assert.equal(missingScopes.result.todo.length, 1);
});

test('login check: a problem that logging in again cannot fix is "blocked", and not being able to reach Feishu is not a lapsed login', async () => {
  const wrongAccount = await main(['login', 'check'], bridgeSaying(goodFeishu), clsSaying('pin'));
  assert.deepEqual([wrongAccount.code, wrongAccount.result.status, wrongAccount.result.cls.status], [2, 'blocked', 'blocked']);
  assert.match(wrongAccount.result.cls.reason, /已绑定/);
  assert.equal(wrongAccount.result.todo, undefined, 'a wrong account is not fixed by asking for another scan');

  const refused = await main(['login', 'check'], bridgeSaying(goodFeishu), clsSaying('consent_refused', { reason: '飞书授权页请求的不是 dsc_admin，没有点击' }));
  assert.deepEqual([refused.result.status, refused.result.cls.status], ['blocked', 'blocked']);

  const other = await main(['login', 'check'], bridgeSaying(fail('identity_mismatch', '不是本人')), clsSaying('ok'));
  assert.deepEqual([other.result.status, other.result.feishu.status], ['blocked', 'identity_mismatch']);

  // A block on one side outranks a login wanted on the other: nobody is asked to scan before the block is reported.
  const both = await main(['login', 'check'], bridgeSaying(fail('config', '未配置飞书应用')), clsSaying('login_required'));
  assert.deepEqual([both.code, both.result.status, both.result.feishu.status, both.result.cls.status], [2, 'blocked', 'blocked', 'login_required']);

  const unreachable = await main(['login', 'check'], bridgeSaying(fail('network')), clsSaying('ok'));
  assert.deepEqual([unreachable.code, unreachable.result.status, unreachable.result.feishu.status], [2, 'unknown', 'unreachable']);
  assert.equal(unreachable.result.todo, undefined, 'no new login is asked for when Feishu merely did not answer');
});

test('login check never prints a token', async () => {
  const text = JSON.stringify([
    await main(['login', 'check'], bridgeSaying(goodFeishu), clsSaying('ok')),
    await main(['login', 'check'], bridgeSaying(fail('auth_required')), clsSaying('login_required')),
  ]);
  assert.ok(!text.includes('secret-token-1') && !/Bearer|authorization/i.test(text));
});
