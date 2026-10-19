import test from 'node:test';
import { tempDir } from './helpers/tmp.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadApp, scopeList } from '../src/config.ts';
import { BridgeError } from '../src/errors.ts';
import { resolveDataPaths } from '../src/paths.ts';

const tmp = () => tempDir('ra-cfg-');

test('the host passes the app in the environment', () => {
  const paths = resolveDataPaths({ LARK_AGENT_USER_DIR: tmp() });
  assert.deepEqual(loadApp({ FEISHU_APP_ID: ' cli_a ', FEISHU_APP_SECRET: 's3cret-000' }, paths), { appId: 'cli_a', appSecret: 's3cret-000' });
  assert.throws(() => loadApp({ FEISHU_APP_ID: 'cli_a' }, paths), (e: BridgeError) => e.kind === 'config' && /宿主传入/.test(e.message));
});

test('a plugin used on its own may keep the app in app.json next to its data, but a host-served user directory never supplies one', () => {
  const dir = tmp();
  try {
    const alone = resolveDataPaths({ PLUGIN_DATA: dir });
    assert.throws(() => loadApp({}, alone), (e: BridgeError) => e.kind === 'config' && e.message.includes(path.join(dir, 'app.json')));
    fs.writeFileSync(path.join(dir, 'app.json'), JSON.stringify({ appId: 'cli_file', appSecret: 'file-secret-1' }));
    assert.deepEqual(loadApp({}, alone), { appId: 'cli_file', appSecret: 'file-secret-1' });
    // The environment still wins.
    assert.equal(loadApp({ FEISHU_APP_ID: 'cli_env', FEISHU_APP_SECRET: 'env-secret-1' }, alone).appId, 'cli_env');

    const hostDir = tmp();
    const host = resolveDataPaths({ LARK_AGENT_USER_DIR: hostDir });
    fs.mkdirSync(host.root, { recursive: true });
    fs.writeFileSync(path.join(host.root, 'app.json'), JSON.stringify({ appId: 'cli_planted', appSecret: 'planted-secret' }));
    assert.throws(() => loadApp({}, host), (e: BridgeError) => e.kind === 'config', 'a file in a user directory is not trusted as the app');
    fs.rmSync(hostDir, { recursive: true, force: true });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('scopes are listed once whatever separates them', () => {
  assert.deepEqual(scopeList('a b,c  a\td'), ['a', 'b', 'c', 'd']);
  assert.deepEqual(scopeList(undefined), []);
});
