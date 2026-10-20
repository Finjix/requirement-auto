import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { REQUIRED_SCOPES } from '../src/config.ts';
import { createServer, TOOL_NAMES } from '../src/mcp.ts';
import { tempDir } from './helpers/tmp.ts';
import { MockFeishu } from './helpers/mock-feishu.ts';

const text = (result: any) => (result.content as { type: string; text: string }[]).map(item => item.text).join('\n');
const bundle = path.resolve(import.meta.dirname, '../../../plugins/requirement-auto/server/dist/mcp.mjs');

async function connect(env: NodeJS.ProcessEnv, endpoints?: { open: string; accounts: string }) {
  const server = createServer({ env, ...(endpoints ? { endpoints } : {}) });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1' });
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

test('the server offers exactly the four login tools, and none of them takes a user, an Open ID or a path', async () => {
  const dir = tempDir('ra-mcp-');
  const { client, close } = await connect({ LARK_AGENT_USER_DIR: dir });
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(tool => tool.name).sort(), [...TOOL_NAMES].sort());
    const allowed = new Set(['force', 'wait_seconds']);
    for (const tool of tools) {
      for (const name of Object.keys((tool.inputSchema as any).properties ?? {})) assert.ok(allowed.has(name), `${tool.name} takes ${name}`);
    }
    const info = client.getServerVersion();
    assert.equal(info?.name, 'feishu-auth');
    assert.match(client.getInstructions() ?? '', /no tool takes a user identifier/);
  } finally { await close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the login runs through the tools: link out, confirmation in, and no token in anything the model sees', async () => {
  const mock = await new MockFeishu().start();
  mock.scope = [...REQUIRED_SCOPES, 'offline_access'].join(' ');
  const dir = tempDir('ra-mcp-');
  const env = { LARK_AGENT_USER_DIR: dir, LARK_AGENT_USER_OPEN_ID: 'ou_alice', FEISHU_APP_ID: mock.appId, FEISHU_APP_SECRET: mock.appSecret };
  const { client, close } = await connect(env, mock.endpoints);
  const seen: string[] = [];
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    seen.push(JSON.stringify(result));
    return result;
  };
  try {
    const before = await call('feishu_auth_status');
    assert.equal((before.structuredContent as any).logged_in, false);
    assert.match(text(before), /Not logged in/);

    const login = await call('feishu_auth_login');
    assert.equal(login.isError, undefined);
    assert.match(text(login), /Authorization link: http:\/\/127\.0\.0\.1:\d+\/verify\?user_code=ABCD-1234/);
    assert.match(text(login), /Code: ABCD-1234/);
    assert.ok(!seen.join('').includes('dev-code-1'), 'the device code stays inside');

    const waiting = await call('feishu_auth_poll', { wait_seconds: 0 });
    assert.equal((waiting.structuredContent as any).state, 'pending');

    mock.deviceScript = ['issue'];
    const done = await call('feishu_auth_poll', { wait_seconds: 5 });
    assert.equal((done.structuredContent as any).state, 'authorized');
    assert.match(text(done), /ou_alice/);

    const again = await call('feishu_auth_login');
    assert.equal((again.structuredContent as any).already_logged_in, true);
    assert.equal(mock.requests('/oauth/v1/device_authorization').length, 1);

    const status = await call('feishu_auth_status');
    assert.equal((status.structuredContent as any).logged_in, true);
    for (const secret of [mock.currentAccess, mock.currentRefresh, mock.appSecret]) {
      assert.ok(!seen.join('').includes(secret), 'a secret reached the tool results');
    }

    await call('feishu_auth_logout');
    assert.equal(((await call('feishu_auth_status')).structuredContent as any).logged_in, false);
  } finally { await close(); await mock.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a login of the wrong person fails inside the tool and says why', async () => {
  const mock = await new MockFeishu().start();
  const dir = tempDir('ra-mcp-');
  const env = { LARK_AGENT_USER_DIR: dir, LARK_AGENT_USER_OPEN_ID: 'ou_bob', FEISHU_APP_ID: mock.appId, FEISHU_APP_SECRET: mock.appSecret };
  const { client, close } = await connect(env, mock.endpoints);
  try {
    await client.callTool({ name: 'feishu_auth_login', arguments: {} });
    mock.deviceScript = ['issue'];
    const result = await client.callTool({ name: 'feishu_auth_poll', arguments: { wait_seconds: 5 } });
    assert.equal(result.isError, true);
    assert.match(text(result), /identity_mismatch/);
    assert.equal(fs.existsSync(path.join(dir, 'requirement-auto', 'feishu', 'auth.json')), false);
  } finally { await close(); await mock.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the bundled server starts over stdio, lists its tools and reports a missing app configuration as a tool error', async () => {
  assert.ok(fs.existsSync(bundle), 'run `npm run build` first');
  const dir = tempDir('ra-mcp-');
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !key.startsWith('FEISHU_') && !key.startsWith('LARK_AGENT')) env[key] = value;
  env.LARK_AGENT_USER_DIR = dir;
  const transport = new StdioClientTransport({ command: process.execPath, args: [bundle], env, stderr: 'pipe' });
  const client = new Client({ name: 'test', version: '1' });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.equal(tools.length, 4);
    const status = await client.callTool({ name: 'feishu_auth_status', arguments: {} });
    assert.equal((status.structuredContent as any).logged_in, false);
    assert.equal((status.structuredContent as any).app_configured, false);
    const login = await client.callTool({ name: 'feishu_auth_login', arguments: {} });
    assert.equal(login.isError, true);
    assert.match(text(login), /config/);
  } finally { await client.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
