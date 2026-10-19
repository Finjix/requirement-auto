import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { BRIDGE_VERSION, COMMANDS, INPUT_COMMANDS, runBridge } from '../src/bridge.ts';
import { REQUIRED_SCOPES } from '../src/config.ts';
import { FeishuAuth } from '../src/auth.ts';
import { resolveDataPaths } from '../src/paths.ts';
import { tempDir } from './helpers/tmp.ts';
import { clock } from './helpers/clock.ts';
import { MockFeishu } from './helpers/mock-feishu.ts';

test('the bridge version is the one the gof command line expects, and every command is known to the entry point', () => {
  assert.equal(BRIDGE_VERSION, 'feishu-sdk-bridge/1');
  for (const name of INPUT_COMMANDS) assert.ok((COMMANDS as readonly string[]).includes(name), name);
  for (const name of ['info', 'auth-status', 'auth-logout']) assert.ok(!INPUT_COMMANDS.has(name), `${name} must not wait on stdin`);
});

test('unknown commands and malformed arguments are refused, not guessed', async () => {
  const env = { LARK_AGENT_USER_DIR: tempDir('ra-br-'), FEISHU_APP_ID: 'cli_x', FEISHU_APP_SECRET: 'secret-000000' };
  try {
    const unknown = await runBridge('rm-rf', {}, { env });
    assert.equal(!unknown.ok && unknown.error.kind, 'invalid_request');
    const array = await runBridge('api-get', [1, 2], { env });
    assert.equal(!array.ok && array.error.kind, 'invalid_request');
    const scopes = await runBridge('auth-check-scopes', { required: [1] }, { env });
    assert.equal(!scopes.ok && scopes.error.kind, 'invalid_request');
    const noApp = await runBridge('auth-login', {}, { env: { LARK_AGENT_USER_DIR: env.LARK_AGENT_USER_DIR } });
    assert.equal(!noApp.ok && noApp.error.kind, 'config');
    // Status and logout work without the app configured: they only touch local files.
    assert.equal((await runBridge('auth-status', undefined, { env: { LARK_AGENT_USER_DIR: env.LARK_AGENT_USER_DIR } })).ok, true);
  } finally { fs.rmSync(env.LARK_AGENT_USER_DIR, { recursive: true, force: true }); }
});

test('the scope check reports what is granted and what is missing without the word "ok", which the gof command line reads as failure', async () => {
  const mock = await new MockFeishu().start();
  const dir = tempDir('ra-br-');
  try {
    mock.scope = [...REQUIRED_SCOPES.slice(0, 5), 'offline_access'].join(' ');
    const c = clock(Date.now());
    const auth = new FeishuAuth({ paths: resolveDataPaths({ LARK_AGENT_USER_DIR: dir }), app: { appId: mock.appId, appSecret: mock.appSecret }, endpoints: mock.endpoints, now: c.now, sleep: c.sleep });
    await auth.startLogin();
    mock.deviceScript = ['issue'];
    await auth.pollLogin(10_000);
    const env = { LARK_AGENT_USER_DIR: dir, FEISHU_APP_ID: mock.appId, FEISHU_APP_SECRET: mock.appSecret };
    const partial = await runBridge('auth-check-scopes', { required: [...REQUIRED_SCOPES] }, { env, endpoints: mock.endpoints });
    assert.equal(partial.ok, true);
    const data = (partial as { data: Record<string, unknown> }).data;
    assert.equal(data.complete, false);
    assert.deepEqual(data.missing, REQUIRED_SCOPES.slice(5));
    assert.ok(!('ok' in data));
    const enough = await runBridge('auth-check-scopes', { required: REQUIRED_SCOPES.slice(0, 5) }, { env, endpoints: mock.endpoints });
    assert.equal((enough as { data: { complete: boolean } }).data.complete, true);
    const info = await runBridge('info', undefined, { env, endpoints: mock.endpoints });
    assert.equal((info as { data: { bridge: string } }).data.bridge, BRIDGE_VERSION);
  } finally { await mock.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});
