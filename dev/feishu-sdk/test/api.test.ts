import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FeishuApi, type CellWrite } from '../src/api.ts';
import { FeishuAuth } from '../src/auth.ts';
import { BridgeError } from '../src/errors.ts';
import { resolveDataPaths } from '../src/paths.ts';
import { tempDir } from './helpers/tmp.ts';
import { clock } from './helpers/clock.ts';
import { MockFeishu } from './helpers/mock-feishu.ts';

const TOKEN = 'shtABCDEFGH';

async function setup() {
  const mock = await new MockFeishu().start();
  const dir = tempDir('ra-api-');
  const c = clock();
  const auth = new FeishuAuth({ paths: resolveDataPaths({ LARK_AGENT_USER_DIR: dir }), app: { appId: mock.appId, appSecret: mock.appSecret }, endpoints: mock.endpoints, now: c.now, sleep: c.sleep });
  await auth.startLogin();
  mock.deviceScript = ['issue'];
  await auth.pollLogin(10_000);
  const api = new FeishuApi(auth, async () => {});
  return { mock, api, auth, dir, done: async () => { await mock.stop(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

const write = (overrides: Record<string, unknown> = {}) => ({ sheet_id: 's1', range: 'A1:A1', cells: [[{ value: 'x' }]], allow_overwrite: false, ...overrides }) as CellWrite;

test('reads go only to the allowlisted endpoints', async () => {
  const { api, mock, done } = await setup();
  try {
    const node = await api.get('/open-apis/wiki/v2/spaces/get_node', { token: 'wiki1', obj_type: 'wiki' });
    assert.equal(node.node.obj_token, 'shtABCDEFGH');
    assert.match(mock.requests('/open-apis/wiki/v2/spaces/get_node')[0]!.url, /token=wiki1&obj_type=wiki|obj_type=wiki&token=wiki1/);
    for (const bad of ['/open-apis/drive/v1/files/abc', '/open-apis/wiki/v2/spaces/get_node?x=1', '/open-apis/wiki/../authen/v1/user_info',
      'https://evil.example/open-apis/wiki/v2/spaces/get_node', '/open-apis/sheets/v2/spreadsheets/abc/values', '/open-apis/im/v1/messages']) {
      await assert.rejects(() => api.get(bad), (e: BridgeError) => e.kind === 'invalid_request', bad);
    }
    await assert.rejects(() => api.get('/open-apis/wiki/v2/spaces/get_node', { token: { nested: 1 } }), (e: BridgeError) => e.kind === 'invalid_request');
    assert.equal(mock.requests('/open-apis/drive').length, 0, 'refused calls are never sent');
  } finally { await done(); }
});

test('a token the server rejects is renewed once and the read retried', async () => {
  const { api, mock, done } = await setup();
  try {
    mock.rejectTokenOnce = true;
    const before = mock.currentAccess;
    const node = await api.get('/open-apis/wiki/v2/spaces/get_node', { token: 'wiki1' });
    assert.equal(node.node.node_token, 'wiki1');
    assert.notEqual(mock.currentAccess, before);
    assert.equal(mock.refreshCount, 1);
  } finally { await done(); }
});

test('the revision comes from the metainfo endpoint', async () => {
  const { api, mock, done } = await setup();
  try {
    assert.equal(await api.revision(TOKEN), 7);
    mock.revision = 8;
    assert.equal(await api.revision(TOKEN), 8);
    await assert.rejects(() => api.revision('../x'), (e: BridgeError) => e.kind === 'invalid_request');
  } finally { await done(); }
});

test('a write goes out exactly as lark-cli sends it, with overwriting switched off', async () => {
  const { api, mock, done } = await setup();
  try {
    await api.cellsSet('shtTEST123', [write()]);
    const sent = mock.requests('/open-apis/sheet_ai/v2/spreadsheets/shtTEST123/tools/invoke_write');
    assert.equal(sent.length, 1);
    // Captured from `lark-cli sheets +cells-set --writes - --allow-overwrite=false --dry-run` (1.0.98).
    const captured = '{"input":"{\\"excel_id\\":\\"shtTEST123\\",\\"operations\\":[{\\"input\\":{\\"allow_overwrite\\":false,\\"cells\\":[[{\\"value\\":\\"x\\"}]],\\"excel_id\\":\\"shtTEST123\\",\\"range\\":\\"A1:A1\\",\\"sheet_id\\":\\"s1\\"},\\"tool_name\\":\\"set_cell_range\\"}]}","tool_name":"batch_update"}';
    assert.equal(sent[0]!.body, captured);
    assert.equal(sent[0]!.headers.authorization, `Bearer ${mock.currentAccess}`);
  } finally { await done(); }
});

test('a write that does not forbid overwriting, or is malformed, is never sent', async () => {
  const { api, mock, done } = await setup();
  try {
    const refused = (writes: unknown) => assert.rejects(() => api.cellsSet(TOKEN, writes as any), (e: BridgeError) => e.kind === 'invalid_request');
    await refused([write({ allow_overwrite: true })]);
    await refused([write({ allow_overwrite: undefined })]);
    await refused([write({ allow_overwrite: 'false' })]);
    await refused([write({ range: 'A1:A1; DROP' })]);
    await refused([write({ sheet_id: '' })]);
    await refused([write({ cells: [] })]);
    await refused([write({ cells: [[]] })]);
    await refused([]);
    await refused(Array.from({ length: 101 }, () => write()));
    await refused([write(), write({ allow_overwrite: true })]);
    await assert.rejects(() => api.cellsSet('../x', [write()]), (e: BridgeError) => e.kind === 'invalid_request');
    assert.equal(mock.requests('/open-apis/sheet_ai').length, 0);
  } finally { await done(); }
});

test('the server refusing a non-empty target is told apart from other failures', async () => {
  const { api, mock, done } = await setup();
  try {
    mock.writeReply = { status: 200, body: { code: 1310999, msg: 'target range is non-empty, cannot overwrite' } };
    await assert.rejects(() => api.cellsSet(TOKEN, [write()]), (e: BridgeError) => e.kind === 'occupied');
    mock.writeReply = { status: 400, body: { code: 1310999, msg: '范围内已有内容，禁止覆盖' } };
    await assert.rejects(() => api.cellsSet(TOKEN, [write()]), (e: BridgeError) => e.kind === 'occupied');
    mock.writeReply = { status: 200, body: { code: 1310001, msg: 'invalid range' } };
    await assert.rejects(() => api.cellsSet(TOKEN, [write()]), (e: BridgeError) => e.kind === 'api');
    mock.writeReply = { status: 200, body: { code: 99991679, msg: 'no permission' } };
    await assert.rejects(() => api.cellsSet(TOKEN, [write()]), (e: BridgeError) => e.kind === 'scope_missing');
    mock.writeReply = { status: 502, body: { msg: 'bad gateway' } };
    await assert.rejects(() => api.cellsSet(TOKEN, [write()]), (e: BridgeError) => e.kind === 'unknown_result');
  } finally { await done(); }
});

test('a write that gets no answer is an unknown result, and it is not resent', async () => {
  const { api, mock, done } = await setup();
  try {
    let attempts = 0;
    mock.server.removeAllListeners('request');
    mock.server.on('request', req => { if (req.url?.includes('invoke_write')) { attempts++; req.socket.destroy(); } });
    await assert.rejects(() => api.cellsSet(TOKEN, [write()]), (e: BridgeError) => e.kind === 'unknown_result');
    assert.equal(attempts, 1, 'sent once, never retried');
  } finally { await done(); }
});

test('a token rejected during a write is not retried', async () => {
  const { api, mock, done } = await setup();
  try {
    mock.rejectTokenOnce = true;
    await assert.rejects(() => api.cellsSet(TOKEN, [write()]), (e: BridgeError) => e.kind === 'auth_required');
    assert.equal(mock.requests('/open-apis/sheet_ai').length, 1);
  } finally { await done(); }
});

test('the workbook is exported to a new XLSX and an existing file is never replaced', async () => {
  const { api, mock, dir, done } = await setup();
  try {
    const out = path.join(dir, 'snap', 'one.xlsx');
    const result = await api.exportXlsx(TOKEN, out);
    assert.equal(result.path, out);
    assert.ok(result.bytes >= 22);
    assert.equal(fs.readFileSync(out).subarray(0, 2).toString(), 'PK');
    const create = mock.requests('/open-apis/drive/v1/export_tasks').find(item => item.method === 'POST')!;
    assert.deepEqual(JSON.parse(create.body), { file_extension: 'xlsx', token: TOKEN, type: 'sheet' });
    await assert.rejects(() => api.exportXlsx(TOKEN, out), (e: BridgeError) => e.kind === 'invalid_request');
    await assert.rejects(() => api.exportXlsx(TOKEN, path.join(dir, 'x.csv')), (e: BridgeError) => e.kind === 'invalid_request');
    await assert.rejects(() => api.exportXlsx(TOKEN, 'relative.xlsx'), (e: BridgeError) => e.kind === 'invalid_request');

    mock.exportJob = [{ job_status: 3 }];
    const failed = path.join(dir, 'snap', 'two.xlsx');
    await assert.rejects(() => api.exportXlsx(TOKEN, failed), (e: BridgeError) => e.kind === 'api');
    assert.equal(fs.existsSync(failed), false);
  } finally { await done(); }
});

test('a new dropdown option keeps every rule its mode and colors: a multiple-choice column stays multiple choice', async () => {
  const { api, mock, done } = await setup();
  try {
    const posted: any[] = [];
    const rules = [
      { dataValidationType: 'list', conditionValues: ['菲比', '丁杰'], ranges: ['s1!M2:M5000'],
        options: { multipleValues: true, highlightValidData: true, colorValueMap: { 菲比: '#bacefd', 丁杰: '#A9EFE6' } } },
      { dataValidationType: 'list', conditionValues: ['甲'], ranges: ['s1!M5001:M5002', 's1!M5005'], options: { multipleValues: false, highlightValidData: false } },
      { dataValidationType: 'list', conditionValues: ['杨燃', '乙'], ranges: ['s1!M5003'], options: { highlightValidData: false } },
    ];
    const original = mock.server.listeners('request');
    mock.server.removeAllListeners('request');
    mock.server.on('request', async (req, res) => {
      if (req.url?.startsWith('/open-apis/sheets/v2/spreadsheets/shtTEST123/dataValidation')) {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        if (req.method === 'POST') posted.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return void res.end(JSON.stringify({ code: 0, data: req.method === 'GET' ? { sheetId: 's1', dataValidations: rules } : {} }));
      }
      (original[0] as (...args: unknown[]) => void)(req, res);
    });
    const result = await api.addDropdownOption('shtTEST123', 's1', 'M', 2, 5001, '杨燃', '#fed4a4');
    assert.deepEqual(result.ranges, ['s1!M2:M5000', 's1!M5001:M5002', 's1!M5005']);
    assert.deepEqual(posted[0], { range: 's1!M2:M5000', dataValidationType: 'list', dataValidation: { conditionValues: ['菲比', '丁杰', '杨燃'],
      options: { multipleValues: true, highlightValidData: true, colors: ['#bacefd', '#A9EFE6', '#fed4a4'] } } });
    assert.deepEqual(posted[1], { range: 's1!M5001:M5002', dataValidationType: 'list', dataValidation: { conditionValues: ['甲', '杨燃'],
      options: { multipleValues: false, highlightValidData: false } } });
    assert.equal(posted.length, 3, 'a rule that already has the option is left alone');
    rules[0]!.options = { multipleValues: true, highlightValidData: true, colorValueMap: { 菲比: '#bacefd' } } as any;
    await assert.rejects(() => api.addDropdownOption('shtTEST123', 's1', 'M', 2, 5001, '新', '#fed4a4'), (e: BridgeError) => /颜色无法可靠保留/.test(e.message));
    assert.equal(posted.length, 3, 'nothing is sent when a rule cannot be kept as it is');
  } finally { await done(); }
});

test('a new workbook is created only through the dedicated call', async () => {
  const { api, mock, done } = await setup();
  try {
    const original = mock.server.listeners('request');
    mock.server.removeAllListeners('request');
    mock.server.on('request', (req, res) => {
      if (req.url === '/open-apis/sheets/v3/spreadsheets' && req.method === 'POST') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return void res.end(JSON.stringify({ code: 0, data: { spreadsheet: { spreadsheet_token: 'shtNEW12345', url: 'https://x/sheets/shtNEW12345' } } }));
      }
      (original[0] as (...args: unknown[]) => void)(req, res);
    });
    const created = await api.createWorkbook('GOFCN_API_SAFETY_x');
    assert.equal(created.spreadsheet_token, 'shtNEW12345');
    await assert.rejects(() => api.createWorkbook(''), (e: BridgeError) => e.kind === 'invalid_request');
  } finally { await done(); }
});
