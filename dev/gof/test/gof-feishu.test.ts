import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRIDGE_VERSION, FeishuServe, type BridgeReply } from '../src/gof/feishu-plugin.ts';
import { status } from '../src/gof/batch.ts';
import { Bridge, OccupiedRefusal, SCOPES, addOption, apiPlan, authorizeFeishu, execute, login, planWithApi, probe, readRules, reconcile, recomputeApiPlan, recomputePlan } from '../src/gof/feishu.ts';
import { readBrief } from '../src/gof/brief.ts';
import { context } from '../src/gof/context.ts';
import { makePlan } from '../src/gof/plan.ts';
import { prepare, record } from '../src/gof/batch.ts';
import { acceptance, dropdowns } from '../src/gof/rules.ts';
import { seal } from '../src/gof/seal.ts';
import { Snapshot } from '../src/gof/snapshot.ts';
import { Blocked, NODE, readJson, WriteSent } from '../src/gof/util.ts';
import { main } from '../src/gof/cli.ts';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gof-feishu-'));
const reply = (data: unknown): BridgeReply => ({ ok: true, data });
const failure = (kind: string, message = 'm'): BridgeReply => ({ ok: false, error: { kind: kind as any, message } });

type Handler = (name: string, payload: any) => BridgeReply | Promise<BridgeReply>;
function bridgeWith(handler: Handler) {
  const calls: { name: string; payload: any }[] = [];
  return { bridge: new Bridge(async (name, payload) => { calls.push({ name, payload }); return handler(name, payload); }), calls };
}
async function failsWith(promise: Promise<unknown>, pattern: RegExp, type: new (...a: any[]) => Error = Blocked): Promise<Error> {
  try { await promise; } catch (error) {
    assert.ok(error instanceof type, (error as Error).stack);
    assert.match((error as Error).message, pattern);
    return error as Error;
  }
  throw new assert.AssertionError({ message: `expected a failure matching ${pattern}` });
}

test('bridge failures map to the refusals the workflow expects, and keep the reason the bridge gave', async () => {
  const cases: [BridgeReply, RegExp, any][] = [
    [failure('occupied'), /非空/, OccupiedRefusal],
    [failure('unknown_result'), /结果未知/, Blocked],
    [failure('auth_required', '飞书登录已过期，请重新授权'), /auth_required.*重新授权/, Blocked],
    [failure('scope_missing', '缺少权限：x'), /缺少权限/, Blocked],
    [failure('api', '导出任务仍未完成（ticket=T123）；稍后只读查询该任务'), /飞书接口调用失败（api）：导出任务仍未完成（ticket=T123）/, Blocked],
  ];
  for (const [result, pattern, type] of cases) {
    const { bridge } = bridgeWith(() => result);
    await failsWith(bridge.call('api-get', { path: '/open-apis/x' }), pattern, type);
  }
  const { bridge } = bridgeWith(() => ({ ok: false, error: { kind: 'api', code: 1310213, message: '飞书接口返回错误（HTTP 403）：forbidden' } }));
  await failsWith(bridge.call('api-get', {}), /错误码 1310213）：飞书接口返回错误（HTTP 403）：forbidden$/);
});

test('an append killed before anything was sent leaves no folder that stops the next one', async () => {
  const { fake, bridge, dir, receipt } = await approvedBatch();
  const leftover = path.join(dir, `api-attempt-${String(status(dir).events.length + 1).padStart(6, '0')}`);
  fs.mkdirSync(leftover);
  fs.writeFileSync(path.join(leftover, 'preflight.xlsx'), 'left over');
  const result = await execute(bridge, dir, receipt);
  assert.equal(result.status, 'append_verified');
  assert.equal(fake.productionWrites, 1);
});

test('a write that got no answer is an unknown result, a read that got none is a plain failure', async () => {
  const { bridge } = bridgeWith(() => failure('network', '无法连接飞书'));
  await failsWith(bridge.call('sheets-cells-set', {}, { write: true }), /结果未知/);
  await failsWith(bridge.call('api-get', {}), /飞书接口调用失败/);
});

test('a reply that reports partial success or truncation is refused', async () => {
  for (const data of [{ errors: [{ code: 1 }] }, { status: 'partial_success' }, { nested: { has_more: true } }, { ok: false }, { failed_count: 2 }]) {
    const { bridge } = bridgeWith(() => reply(data));
    await failsWith(bridge.call('api-get', {}), /接口/);
  }
  const { bridge } = bridgeWith(() => reply({ items: [{ ok: true, has_more: false, errors: [] }] }));
  assert.deepEqual(await bridge.call('api-get', {}), { items: [{ ok: true, has_more: false, errors: [] }] });
});

test('reads stay under /open-apis/ without query strings, and a write without the no-overwrite flag never leaves', async () => {
  const { bridge, calls } = bridgeWith(() => reply({}));
  for (const bad of ['/other', '/open-apis/a/../b', '/open-apis/a?x=1', 'https://x/open-apis/a']) await failsWith(bridge.apiRead(bad), /非法 API 路径/);
  for (const writes of [[], [{ sheet_id: 's', range: 'A1:A1', cells: [[{}]] }], [{ allow_overwrite: true }], 'x'] as any[]) {
    await failsWith(bridge.cellsSet('shtABCDEFGH', writes), /不可覆盖/);
  }
  await failsWith(bridge.cellsSet('../x', [{ allow_overwrite: false }]), /非法表格 token/);
  assert.equal(calls.length, 0);
  await bridge.cellsSet('shtABCDEFGH', [{ sheet_id: 's', range: 'A1:A1', cells: [[{ value: 1 }]], allow_overwrite: false }]);
  assert.equal(calls[0]!.name, 'sheets-cells-set');
  assert.equal(calls[0]!.payload.writes[0].allow_overwrite, false);
});

test('doctor needs the right bridge, a configured app, a login and every scope', async () => {
  const handler = (overrides: Record<string, BridgeReply>): Handler => name => ({
    info: reply({ bridge: BRIDGE_VERSION, app_configured: true, node: 'v24' }),
    'auth-status': reply({ logged_in: true, name: '李小明', open_id: 'ou_1', storage: 'host' }),
    'auth-check-scopes': reply({ complete: true, granted: SCOPES, missing: [] }),
    ...overrides,
  } as Record<string, BridgeReply>)[name]!;
  const { bridge, calls } = bridgeWith(handler({}));
  const result = await bridge.doctor();
  assert.deepEqual([result.user_name, result.open_id, result.identity], ['李小明', 'ou_1', 'user']);
  assert.deepEqual(calls.map(c => c.name), ['info', 'auth-status', 'auth-check-scopes']);
  assert.deepEqual(calls[2]!.payload.required, SCOPES);
  assert.ok(!JSON.stringify(result).toLowerCase().includes('token'));
  for (const [overrides, pattern] of [
    [{ info: reply({ bridge: 'other/9', app_configured: true }) }, /版本/],
    [{ info: reply({ bridge: BRIDGE_VERSION, app_configured: false }) }, /未配置飞书应用/],
    [{ 'auth-status': reply({ logged_in: false }) }, /尚未授权/],
    [{ 'auth-check-scopes': reply({ complete: false, granted: [], missing: ['x'] }) }, /缺少本流程必要权限/],
  ] as [Record<string, BridgeReply>, RegExp][]) {
    await failsWith(bridgeWith(handler(overrides)).bridge.doctor(), pattern);
  }
});

test('login and authorize are the feishu plugin commands, run with this user’s environment, bounded waits checked first', async () => {
  // A stand-in for feishu.mjs that answers with what it was asked and for whom.
  const fake = path.join(tmp(), 'feishu.mjs');
  fs.writeFileSync(fake, 'process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), user: process.env.LARK_AGENT_USER_DIR })); process.exitCode = process.argv.includes("poll") ? 2 : 0;');
  const alice = path.join(tmp(), 'alice');
  const before = { ...process.env };
  Object.assign(process.env, { FEISHU_PLUGIN: fake, LARK_AGENT_USER_DIR: alice });
  try {
    assert.deepEqual(await login('start', { probeScope: true }), { result: { argv: ['login', 'start', '--extra-scope', 'sheets:spreadsheet:create'], user: alice }, code: 0 });
    assert.deepEqual((await login('poll', { wait: 7 })), { result: { argv: ['login', 'poll', '--wait', '7'], user: alice }, code: 2 }, 'its exit code comes along');
    assert.deepEqual((await authorizeFeishu('q.png')).result.argv, ['authorize', '--qr', 'q.png']);
    const viaGof = await main(['feishu', 'login', 'status'], new Bridge(async () => { throw new Error('the bridge is not used'); }));
    assert.deepEqual(viaGof, { result: { argv: ['login', 'status'], user: alice }, code: 0 });
    await failsWith(login('poll', { wait: 51 }), /0 到 50/);
    await failsWith(login('nope'), /未知登录动作/);
  } finally {
    for (const key of ['FEISHU_PLUGIN', 'LARK_AGENT_USER_DIR']) { if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key]; }
  }
});

/** The server side of the safety probe: it refuses to write over a non-empty cell, like the real allow_overwrite=false. */
class FakeSheets {
  enforce = true;
  probeCells = new Map<string, string>();
  writes: string[] = [];
  production: Handler | undefined;

  handle: Handler = (name, payload) => {
    switch (name) {
      case 'info': return reply({ bridge: BRIDGE_VERSION, app_configured: true, node: 'v24' });
      case 'auth-status': return reply({ logged_in: true, name: '李小明', open_id: 'ou_1', storage: 'host' });
      case 'auth-check-scopes': return reply({ complete: true, granted: payload.required, missing: [] });
      case 'sheets-create': return reply({ spreadsheet_token: 'shtPROBE12345' });
      default: break;
    }
    const token = payload?.token ?? /spreadsheets\/(\w+)\//.exec(payload?.path ?? '')?.[1];
    if (token === 'shtPROBE12345') return this.probe(name, payload);
    return this.production!(name, payload);
  };

  private probe(name: string, payload: any): BridgeReply {
    if (name === 'api-get') {
      if (payload.path.endsWith('/sheets/query')) return reply({ sheets: [{ sheet_id: 'p1', resource_type: 'sheet', title: 'Sheet1', index: 0 }] });
      if (payload.path.endsWith('/values_batch_get')) return reply({ valueRanges: [{ values: [[this.probeCells.get('A1') ?? '', this.probeCells.get('B1') ?? '']] }] });
    }
    if (name === 'sheets-cells-set') {
      for (const write of payload.writes) {
        const cols = write.range === 'B1:B1' ? ['B'] : write.range === 'A1:A1' ? ['A'] : ['A', 'B'];
        const targets = cols.map(c => `${c}1`);
        if (this.enforce && targets.some(t => this.probeCells.has(t))) return failure('occupied');
        write.cells[0].forEach((cell: any, i: number) => this.probeCells.set(targets[i]!, cell.formula ?? cell.value));
        this.writes.push(write.range);
      }
      return reply({ applied: true });
    }
    throw new Error(`unexpected probe call ${name}`);
  }
}

function productionNode() {
  return { node: { node_token: NODE, obj_type: 'sheet', obj_token: 'shtPRODUCTION' } };
}

test('the probe records three refused overwrites; its receipt opens production appends only for this bridge', async () => {
  const server = new FakeSheets();
  server.production = (name, payload) => {
    assert.equal(payload.path.endsWith('/spaces/get_node'), true);
    return reply(productionNode());
  };
  const { bridge } = bridgeWith(server.handle);
  const dir = tmp();
  const receipt = path.join(dir, 'receipt.json');
  const result = await probe(bridge, receipt);
  assert.equal(result.status, 'safety_verified');
  assert.deepEqual(server.writes, ['A1:B1']);
  const data = acceptance(receipt, BRIDGE_VERSION);
  assert.deepEqual([data.bridge_version, data.schema], [BRIDGE_VERSION, 2]);
  assert.deepEqual(data.passed, ['occupied_value', 'empty_formula', 'repeated_occupancy']);
  assert.notEqual(data.probe_workbook, data.production_token);
  const write = (name: string, value: unknown) => { const file = path.join(dir, name); fs.writeFileSync(file, JSON.stringify(value)); return file; };
  const { receipt_id, ...body } = data;
  for (const forged of [{ ...body, bridge_version: 'feishu-sdk-bridge/0' }, { ...body, schema: 1 },
    { ...body, bridge_version: undefined, schema: 1, cli_version: '1.0.98' }]) {
    assert.throws(() => acceptance(write('f.json', seal(forged, 'receipt_id')) as string, BRIDGE_VERSION), Blocked);
    fs.rmSync(path.join(dir, 'f.json'));
  }
  assert.throws(() => acceptance(write('edited.json', { ...data, passed: [] }), BRIDGE_VERSION), Blocked);
  // An existing receipt is never overwritten, and nothing is sent.
  const { bridge: other, calls } = bridgeWith(server.handle);
  await failsWith(probe(other, receipt), /不能覆盖/);
  assert.equal(calls.length, 0);
});

test('a server that overwrites fails the probe and no receipt is written', async () => {
  const server = new FakeSheets();
  server.enforce = false;
  server.production = () => reply(productionNode());
  const receipt = path.join(tmp(), 'receipt.json');
  await failsWith(probe(bridgeWith(server.handle).bridge, receipt), /防覆盖探测失败/);
  assert.equal(fs.existsSync(receipt), false);
});

test('the feishu plugin’s bridge (the real one, next to this repository) answers for this user and enforces its own allowlist', async () => {
  const userDir = tmp();
  const serve = new FeishuServe({ ...process.env, LARK_AGENT_USER_DIR: userDir, FEISHU_APP_ID: 'cli_x', FEISHU_APP_SECRET: 'secret-000000' });
  try {
    const bridge = new Bridge((command, input) => serve.call(command, input));
    const info = await bridge.call('info');
    assert.deepEqual([info.bridge, info.storage, info.browser_profile], [BRIDGE_VERSION, 'host', path.join(userDir, 'feishu', 'browser-profile')]);
    assert.deepEqual([(await bridge.call('auth-status')).logged_in], [false]);
    await failsWith(bridge.doctor(), /尚未授权/);
    await failsWith(bridge.call('api-get', { path: '/open-apis/im/v1/messages' }), /invalid_request/);
  } finally { serve.close(); }
});

test('a dropdown keeps the options of the rule it follows and adds only what the request asks for', () => {
  const rule = { sheet_id: 's1', ranges: ['E2:E5'], type: 'list' as const, options: ['a', 'b'], multiple: false, highlight: true, colors: { a: '#111111', b: '#222222' } };
  // `spec.options` comes from the XLSX export, which can carry the options of a stray rule on a few old cells; none of that may be written.
  const plan: any = { range: 'E6:E8', request: { groups: [{ secondary_tag: '2min' }, { secondary_tag: 'a' }, {}] },
    dropdowns: [{ field: 'secondary_tag', range: 'E6:E8', options: ['stray1', 'stray2', 'a', '2min'], missing: ['stray1', 'stray2', '2min'] }] };
  const [d] = dropdowns(plan, 's1', [rule]);
  assert.deepEqual([d.options, d.missing, d.colors.slice(0, 2)], [['a', 'b', '2min'], ['2min'], ['#111111', '#222222']]);
});

test('dropdown colors are the same color in either letter case', async () => {
  const sheet = [{ sheet_id: 's1', grid_properties: { row_count: 10, column_count: 5 } }];
  const rule = (color: string) => ({ dataValidationType: 'list', conditionValues: ['a'], ranges: ['s1!A2:A5'], options: { colorValueMap: { a: color }, highlightValidData: true } });
  const read = async (color: string) => (await readRules(new Bridge(async () => reply({ sheetId: 's1', dataValidations: [rule(color)] })), 'tok', sheet))[0]!.colors;
  assert.deepEqual(await read('#BACEFD'), { a: '#bacefd' });
  assert.deepEqual(await read('#bacefd'), { a: '#bacefd' });
});

test('a dropdown-rule reply of the wrong shape is refused with its field names and types, never its values', async () => {
  const sheet = [{ sheet_id: 's1', grid_properties: { row_count: 10, column_count: 5 } }];
  const read = (data: unknown) => readRules(new Bridge(async () => reply(data)), 'tok', sheet);
  assert.deepEqual(await read({ sheetId: 's1', dataValidations: [] }), []);
  // The real reply for a sheet without dropdowns leaves `dataValidations` out entirely.
  assert.deepEqual(await read({ sheetId: 's1', revision: 7, spreadsheetToken: 'tok' }), []);
  await failsWith(read({ sheetId: 's1', secret: 'hunter2' }), /sheetId 一致；字段 sheetId:string,secret:string(?!.*hunter2)/);
  await failsWith(read({ dataValidations: [] }), /sheetId 缺失；字段 dataValidations:array/);
  await failsWith(read({ sheetId: 'other', dataValidations: [] }), /sheetId 与请求不同/);
  await failsWith(read({ sheetId: 's1', dataValidations: null }), /dataValidations:null/);
  await failsWith(read([]), /sheetId 缺失/);
});

// ---- a whole append against a fake Feishu: plan → prepare → probe receipt → append → read back → reconcile

class FakeProduction {
  appended = false;
  productionWrites = 0;
  failWrite: BridgeReply | undefined;
  /** What the workbook looks like once the write landed: the appended rows, plus whatever colleagues changed meanwhile. */
  after = 'applied-complete.xlsx';
  /** A write that lands but whose answer is lost on the way back. */
  landThenFail: BridgeReply | undefined;
  /** Dropdown rules colleagues change once the write is in. */
  colleagueRules: (rules: any[]) => any[] = rules => rules;
  extraRules: any[] = [];
  readonly sheets = [{ sheet_id: 's1', title: '说明' }, { sheet_id: 's2', title: 'GOFCN创意进度 26年2月' }, { sheet_id: 's3', title: 'GOFCN创意进度 26年3月' }];

  handle: Handler = async (name, payload) => {
    if (name === 'api-get') {
      const p: string = payload.path;
      if (p.endsWith('/spaces/get_node')) return reply(productionNode());
      if (p.endsWith('/sheets/query')) {
        return reply({ sheets: this.sheets.map((s, index) => ({ ...s, index, resource_type: 'sheet', grid_properties: { row_count: 1000, column_count: 20 } })) });
      }
      if (p.endsWith('/dataValidation')) {
        const sid = String(payload.params.range).split('!')[0];
        const rules = sid === 's3' ? this.mainRules() : [];
        return reply({ sheetId: sid, dataValidations: rules });
      }
    }
    if (name === 'sheets-revision') return reply({ revision: 42 });
    if (name === 'sheets-export') {
      fs.copyFileSync(path.join(fixtures, this.appended ? this.after : 'base.xlsx'), payload.output, fs.constants.COPYFILE_EXCL);
      return reply({ path: payload.output, bytes: 1 });
    }
    if (name === 'sheets-cells-set') {
      if (this.failWrite) return this.failWrite;
      assert.ok(payload.writes.every((w: any) => w.allow_overwrite === false));
      this.appended = true;
      this.productionWrites++;
      for (const w of payload.writes) {
        const first = w.cells[0][0].data_validation;
        if (first) {
          this.extraRules.push({ dataValidationType: 'list', conditionValues: first.items, ranges: [`s3!${w.range}`],
            options: { multipleValues: first.support_multiple_values, highlightValidData: first.enable_highlight, colorValueMap: {} } });
        }
      }
      if (this.landThenFail) return this.landThenFail;
      return reply({ applied: true });
    }
    return new FakeSheets().handle(name, payload);
  };

  private mainRules() {
    const rule = (items: string[], range: string) => ({ dataValidationType: 'list', conditionValues: items, ranges: [`s3!${range}`],
      options: { multipleValues: false, highlightValidData: false, colorValueMap: {} } });
    const rules = [rule(['玩法', '画面', '系统'], 'D2:D500'), rule(['卖点', '体验'], 'E2:E500'), rule(['视频', '图文'], 'F2:F500'),
      rule(['供应商甲', '供应商乙'], 'H2:H5'), rule(['张三', '李四'], 'I2:I500'), ...this.extraRules];
    return this.appended ? this.colleagueRules(rules) : rules;
  }
}

async function approvedBatch() {
  const fake = new FakeProduction();
  const probeServer = new FakeSheets();
  probeServer.production = fake.handle;
  const bridge = new Bridge(async (name, payload) => probeServer.handle(name, payload));
  const base = new Snapshot(path.join(fixtures, 'base.xlsx'));
  const request = readJson(path.join(fixtures, 'requests', 'basic.json'));
  const approved = await planWithApi(bridge, base, request);
  assert.equal(approved.api_plan.sheet_id, 's3');
  assert.deepEqual(approved.api_plan.dropdowns.map((d: any) => [d.field, d.range, d.missing]),
    [['primary_tag', 'D6:D8', []], ['secondary_tag', 'E6:E8', []], ['creative_form', 'F6:F8', []],
      ['supplier', 'H6:H8', ['供应商丙']], ['creator', 'I6:I8', []]]);
  const recomputed = await recomputeApiPlan(bridge, base, approved);
  const dir = prepare(approved.batch_plan, base, { outputRoot: tmp(), apiPlan: recomputed }).batch as string;
  const receipt = path.join(tmp(), 'receipt.json');
  await probe(bridge, receipt);
  return { fake, bridge, dir, receipt, base, approved };
}

test('a whole append: plan, prepare, safety receipt, one write, read back and verified, then a read-only reconcile', async () => {
  const { fake, bridge, dir, receipt } = await approvedBatch();
  const result = await execute(bridge, dir, receipt);
  assert.equal(result.status, 'append_verified');
  assert.equal(result.range, 'A6:I8');
  assert.equal(result.sheet_url, 'https://centurygames.feishu.cn/wiki/GH7cwIxzZi3gVdk2s3tc1dDbnQc?sheet=s3');
  assert.equal(readJson(result.report).links.progress_sheet, result.sheet_url);
  assert.equal(fake.productionWrites, 1);
  const state = status(dir);
  assert.deepEqual([state.append_verified, state.blocked], [true, false]);
  assert.ok(fs.existsSync(result.report));
  assert.ok(!JSON.stringify(state).toLowerCase().includes('bearer'));
  // Nothing is ever sent twice.
  await failsWith(execute(bridge, dir, receipt), /已有接口写入尝试/);
  const readback = await reconcile(bridge, dir);
  assert.equal(readback.status, 'complete');
  assert.ok(fake.appended);
});

test('a write whose result is unknown blocks the batch instead of retrying', async () => {
  const { fake, bridge, dir, receipt } = await approvedBatch();
  fake.failWrite = failure('unknown_result');
  await failsWith(execute(bridge, dir, receipt), /结果未知/);
  assert.equal(status(dir).blocked, true);
  fake.failWrite = undefined;
  await failsWith(execute(bridge, dir, receipt), /已有接口写入尝试/);
});

test('an append is refused when the spreadsheet changed since the approved plan', async () => {
  const { bridge, dir, receipt } = await approvedBatch();
  const changing = new Bridge(async (name, payload) => name === 'sheets-revision' ? reply({ revision: 43 }) : (bridge as any).run(name, payload));
  await failsWith(execute(changing, dir, receipt), /表格版本变化/);
  assert.equal(status(dir).events.length, 0);
  // A refusal before anything was sent leaves no attempt directory behind, so the same batch can try again.
  assert.deepEqual(fs.readdirSync(dir).filter(name => name.startsWith('api-attempt-')), []);
  assert.equal((await execute(bridge, dir, receipt)).status, 'append_verified');
});

test('colleagues editing elsewhere in the shared workbook while the append runs do not fail it: their edits are listed, the append is verified', async () => {
  for (const after of ['applied-outside-value.xlsx', 'applied-outside-sheet.xlsx', 'applied-outside-style.xlsx', 'applied-filter-changed.xlsx', 'applied-extra-sheet.xlsx']) {
    const { fake, bridge, dir, receipt } = await approvedBatch();
    fake.after = after;
    const result = await execute(bridge, dir, receipt);
    assert.equal(result.status, 'append_verified', after);
    assert.ok(result.foreign_changes.length > 0, after);
    assert.equal(status(dir).append_verified, true, after);
  }
});

test('a dropdown a colleague changes in a column the append does not write is theirs; one changed in a written column still fails it', async () => {
  const other = await approvedBatch();
  other.fake.colleagueRules = rules => [...rules, { ...rules[0], conditionValues: ['是', '否'], ranges: ['s3!K2:K500'] }];
  assert.equal((await execute(other.bridge, other.dir, other.receipt)).status, 'append_verified');
  const written = await approvedBatch();
  written.fake.colleagueRules = rules => rules.map((r, i) => i === 0 ? { ...r, conditionValues: [...r.conditionValues, '新玩法'] } : r);
  await failsWith(execute(written.bridge, written.dir, written.receipt), /写入已发出.*历史下拉规则/, WriteSent);
});

test('what touches the appended rows still fails the append, and every refusal after the send says the write went out', async () => {
  for (const [after, issue] of [['applied-occupied-optional.xlsx', /J6/], ['applied-bad-value.xlsx', /D6/], ['applied-protected.xlsx', /保护/]] as const) {
    const { fake, bridge, dir, receipt } = await approvedBatch();
    fake.after = after;
    const error = await failsWith(execute(bridge, dir, receipt), /写入已发出.*reconcile.*追加未完整通过验收/, WriteSent) as WriteSent;
    assert.equal(error.batch, dir);
    assert.equal(status(dir).blocked, true, after);
    const readback = await reconcile(bridge, dir);
    assert.equal(readback.status, 'conflict', after);
    assert.match(readback.issues.join(' '), issue, after);
  }
});

test('reconcile of a write that landed nowhere gives its verdict even though the new rows have no dropdowns', async () => {
  const { fake, bridge, dir, receipt } = await approvedBatch();
  fake.failWrite = failure('unknown_result');
  await failsWith(execute(bridge, dir, receipt), /写入已发出/, WriteSent);
  const readback = await reconcile(bridge, dir);
  assert.equal(readback.status, 'not_applied');
  assert.match(readback.rule_issue, /新增下拉规则/);
});

test('a request whose earlier write landed but was never verified cannot be planned and appended again; one that landed nowhere can', async () => {
  const landed = await approvedBatch();
  landed.fake.landThenFail = failure('unknown_result');
  await failsWith(execute(landed.bridge, landed.dir, landed.receipt), /写入已发出/, WriteSent);
  const request = readJson(path.join(fixtures, 'requests', 'basic.json'));
  // The sheet as it is now: the rows of the lost answer are in it, so a new plan would put them in again after themselves.
  const now = new Snapshot(path.join(fixtures, 'applied-complete.xlsx'));
  const again = await planWithApi(landed.bridge, now, request);
  assert.notEqual(again.batch_plan.first_number, landed.approved.batch_plan.first_number);
  assert.throws(() => prepare(again.batch_plan, now, { outputRoot: path.dirname(landed.dir), apiPlan: again.api_plan }), /已有一批写入发出、尚未核对/);

  const nowhere = await approvedBatch();
  nowhere.fake.failWrite = failure('unknown_result');
  await failsWith(execute(nowhere.bridge, nowhere.dir, nowhere.receipt), /写入已发出/, WriteSent);
  const retry = await recomputeApiPlan(nowhere.bridge, nowhere.base, nowhere.approved);
  // Same sheet as approved (nothing landed): a batch of its own beside the first, which keeps its record.
  const fresh = prepare(nowhere.approved.batch_plan, nowhere.base, { outputRoot: path.dirname(nowhere.dir), apiPlan: retry });
  assert.equal(fresh.status, 'prepared');
  assert.equal(path.basename(fresh.batch), `${path.basename(nowhere.dir)}-2`);
  nowhere.fake.failWrite = undefined;
  assert.equal((await execute(nowhere.bridge, fresh.batch, nowhere.receipt)).status, 'append_verified');
});

test('a batch made through the bridge takes CLS evidence only as API receipts, whatever the evidence says about itself', async () => {
  const { bridge, dir, receipt } = await approvedBatch();
  await execute(bridge, dir, receipt);
  record(dir, 'cls_started', '01');
  const shot = path.join(tmp(), 'shot.png');
  fs.writeFileSync(shot, 'x');
  const forged = { confirmed: true, unpublished: true, url: 'https://creative.centurygames.cn/requirement/1/edit-outer', screenshot: shot };
  assert.throws(() => record(dir, 'draft_saved', '01', forged), /transport=cls_api/);
  assert.throws(() => record(dir, 'draft_saved', '01', { ...forged, transport: 'ui' }), /transport=cls_api/);
  assert.throws(() => record(dir, 'append_verified', '01', {}), /不属于某个组|追加验证/);
});

test('the command line reports a refusal as blocked JSON with exit code 2', async () => {
  const result = await main(['batch', 'status', '--batch', path.join(tmp(), 'nothing')]);
  assert.equal(result.code, 2);
  assert.equal(result.result.status, 'blocked');
  assert.equal((await main(['frobnicate'])).code, 2);
  assert.equal((await main(['batch', 'plan', '--bogus', 'x'])).code, 2);
  void apiPlan; void makePlan;
});

// ---- reading the requirement document, the context for filling a request, dropdown options, planning again on a fresh snapshot

class FakeDocs {
  readonly tabs = [
    { sheet_id: 't1', title: '2026.10.10', index: 0, resource_type: 'sheet', hidden: false, grid_properties: { row_count: 4, column_count: 4 } },
    { sheet_id: 't2', title: '2026.10.16', index: 2, resource_type: 'sheet', hidden: false, grid_properties: { row_count: 4, column_count: 4 } },
    { sheet_id: 'tx', title: '隐藏', index: 3, resource_type: 'sheet', hidden: true, grid_properties: { row_count: 4, column_count: 4 } },
    { sheet_id: 'tb', title: '多维表格', index: 1, resource_type: 'bitable', hidden: false },
  ];
  values = [['序号', '创意形式\n（制作形式）', '脚本', null], [1, 'AI剧情', 'x'.repeat(400), [{ type: 'attachment', text: '1.mp4', fileToken: 'f1' }]],
    [null, null, '', null], [2, '设定3.0', [{ type: 'text', text: '短' }, { type: 'mention', text: '@张三' }], { type: 'embed-image', fileToken: 'g1' }]];
  ranges: string[] = [];

  handle: Handler = (name, payload) => {
    assert.equal(name, 'api-get');
    const p: string = payload.path;
    if (p.endsWith('/spaces/get_node')) {
      const nodes: Record<string, unknown> = {
        wikiSHEET: { obj_type: 'sheet', obj_token: 'shtREQ', title: '丁杰AI', parent_node_token: 'wikiDIR' },
        wikiDIR: { obj_type: 'docx', obj_token: 'doxDIR', title: '张天伟', parent_node_token: 'wikiROOT' },
        wikiROOT: { obj_type: 'docx', obj_token: 'doxROOT', title: '点点互动', parent_node_token: '' },
        wikiDOC: { obj_type: 'docx', obj_token: 'doxREQ', title: '丁杰代言人需求表' },
        wikiMIND: { obj_type: 'mindnote', obj_token: 'mndREQ', title: '脑图' },
      };
      return reply({ node: nodes[payload.params.token] });
    }
    if (p === '/open-apis/sheets/v3/spreadsheets/shtREQ') return reply({ spreadsheet: { title: '杨燃对接文档' } });
    if (p.endsWith('/sheets/query')) return reply({ sheets: this.tabs });
    if (p.endsWith('/values_batch_get')) {
      this.ranges.push(payload.params.ranges);
      return reply({ valueRanges: [{ range: payload.params.ranges, values: this.values }] });
    }
    if (p === '/open-apis/docx/v1/documents/doxREQ/raw_content') return reply({ content: '丁杰代言人需求表\n2026.10.19\n根据给到的物料混剪产出44条素材' });
    throw new Error(`unexpected ${p}`);
  };
}

test('a requirement sheet is read as the linked tab (or the newest), its header and its non-empty rows, cells as plain text', async () => {
  const docs = new FakeDocs();
  const { bridge } = bridgeWith(docs.handle);
  const linked = await readBrief(bridge, 'https://centurygames.feishu.cn/wiki/wikiSHEET?sheet=t1');
  assert.deepEqual([linked.kind, linked.title, linked.sheet], ['sheet', '丁杰AI', { sheet_id: 't1', title: '2026.10.10', chosen_by: 'link' }]);
  assert.deepEqual(linked.path, ['点点互动', '张天伟']);
  assert.deepEqual(linked.tabs, ['2026.10.10', '2026.10.16']);
  assert.deepEqual(linked.columns, ['A', 'B', 'C', 'D']);
  assert.deepEqual(linked.header, ['序号', '创意形式\n（制作形式）', '脚本', '']);
  assert.deepEqual(linked.rows.map((r: any) => r.row), [2, 4]);
  assert.deepEqual(linked.rows[0].cells, ['1', 'AI剧情', `${'x'.repeat(300)}…`, '[附件:1.mp4]']);
  assert.deepEqual(linked.rows[1].cells, ['2', '设定3.0', '短@张三', '[图片]']);
  assert.deepEqual([linked.row_count, linked.clipped_cells, docs.ranges[0]], [2, 1, 't1!A1:D4']);
  const newest = await readBrief(bridge, 'https://centurygames.feishu.cn/wiki/wikiSHEET');
  assert.deepEqual(newest.sheet, { sheet_id: 't2', title: '2026.10.16', chosen_by: 'last' });
  const asked = await readBrief(bridge, 'https://centurygames.feishu.cn/wiki/wikiSHEET', { sheet: '2026.10.10', full: true });
  assert.deepEqual([asked.sheet.chosen_by, asked.rows[0].cells[2].length, asked.clipped_cells], ['asked', 400, undefined]);
  const direct = await readBrief(bridge, 'https://centurygames.feishu.cn/sheets/shtREQ?sheet=t2');
  assert.deepEqual([direct.title, direct.sheet.chosen_by, direct.path], ['杨燃对接文档', 'link', undefined]);
  await failsWith(readBrief(bridge, 'https://centurygames.feishu.cn/wiki/wikiSHEET?sheet=tx'), /链接指向的工作表不存在或已隐藏/);
  await failsWith(readBrief(bridge, 'https://centurygames.feishu.cn/wiki/wikiSHEET', { sheet: '没有' }), /没有工作表“没有”/);
});

test('a requirement doc is read as its text with its title; other kinds of document and other hosts are refused', async () => {
  const { bridge } = bridgeWith(new FakeDocs().handle);
  const doc = await readBrief(bridge, 'https://centurygames.feishu.cn/wiki/wikiDOC');
  assert.deepEqual([doc.kind, doc.title, doc.chars], ['docx', '丁杰代言人需求表', 36]);
  assert.match(doc.text, /产出44条素材/);
  const direct = await readBrief(bridge, 'https://centurygames.feishu.cn/docx/doxREQ');
  assert.equal(direct.title, '丁杰代言人需求表');
  await failsWith(readBrief(bridge, 'https://centurygames.feishu.cn/wiki/wikiMIND'), /暂不支持读取这种飞书文档（mindnote）/);
  await failsWith(readBrief(bridge, 'https://evil.example.com/docx/doxREQ'), /不是公司飞书文档链接/);
  await failsWith(readBrief(bridge, 'https://centurygames.feishu.cn/docx/doxREQ', { sheet: 't1' }), /只用于表格/);
});

test('the context gives the target sheet, the next number and the dropdown options, and no earlier rows or batches', async () => {
  const fake = new FakeProduction();
  const probeServer = new FakeSheets();
  probeServer.production = fake.handle;
  const bridge = new Bridge(async (name, payload) => probeServer.handle(name, payload));
  const base = new Snapshot(path.join(fixtures, 'base.xlsx'));
  const result = await context(bridge, base);
  assert.deepEqual([result.worksheet, result.sheet_id, result.next_number], ['GOFCN创意进度 26年3月', 's3', 1011]);
  // How the next row will be named, so that files named for their rows can be split into its parts.
  assert.equal(result.naming, 'GOFCN<素材编号>_<一级标签>_<二级标签>_<创意形式>_<提炼词>');
  assert.deepEqual(result.options, { primary_tag: ['玩法', '画面', '系统'], secondary_tag: ['卖点', '体验'], creative_form: ['视频', '图文'],
    supplier: ['供应商甲', '供应商乙'], creator: ['张三', '李四'] });
  assert.equal('recent' in result || 'past_requests' in result, false);
});

test('dropdown-add finds the column of each of the five fields by its header and adds to the whole column', async () => {
  const header: unknown[] = ['素材编号', '提炼词', '素材名称', '一级标签\n（方向）', '二级标签（卖点）', [{ type: 'text', text: '创意形式（制作形式）' }], '客户端',
    '设计师供应商', '创意者\n脚本审核人'];
  const sent: any[] = [];
  const handler: Handler = (name, payload) => {
    if (name === 'info') return reply({ bridge: BRIDGE_VERSION, app_configured: true, node: 'v24' });
    if (name === 'auth-status') return reply({ logged_in: true, name: '李小明', open_id: 'ou_1', storage: 'host' });
    if (name === 'auth-check-scopes') return reply({ complete: true, granted: payload.required, missing: [] });
    if (name === 'sheets-dropdown-add') { sent.push(payload); return reply({ updated_ranges: 2 }); }
    const p: string = payload.path;
    if (p.endsWith('/spaces/get_node')) return reply(productionNode());
    if (p.endsWith('/sheets/query')) {
      return reply({ sheets: [{ sheet_id: 's3', title: '26年1月-GOFCN', index: 0, resource_type: 'sheet', grid_properties: { row_count: 7000, column_count: 14 } }] });
    }
    if (p.endsWith('/values_batch_get')) { assert.equal(payload.params.ranges, 's3!A1:N1'); return reply({ valueRanges: [{ values: [header] }] }); }
    throw new Error(`unexpected ${name} ${p}`);
  };
  const { bridge } = bridgeWith(handler);
  const columns: string[] = [];
  for (const field of ['primary', 'secondary', 'form', 'supplier', 'reviewer', 'creative_form', 'creator']) {
    const result = await addOption(bridge, field, '新选项', '26年1月-GOFCN', '#bacefd');
    columns.push(result.column);
    assert.equal(result.updated_ranges, 4);
  }
  assert.deepEqual(columns, ['D', 'E', 'F', 'H', 'I', 'F', 'I']);
  assert.deepEqual(sent.slice(0, 2).map(s => [s.column, s.first_row, s.last_row, s.option, s.color]),
    [['D', 2, 5001, '新选项', '#bacefd'], ['D', 5002, 7000, '新选项', '#bacefd']]);
  await failsWith(addOption(bridge, 'client', 'x', '26年1月-GOFCN'), /--field 必须是/);
  await failsWith(addOption(bridge, 'supplier', 'x', '没有的表'), /找不到工作表/);
  header.push('供应商备注');
  await failsWith(addOption(bridge, 'supplier', 'x', '26年1月-GOFCN'), /找不到唯一的供应商列/);
});

test('the approved plan is made again on a fresh snapshot: a new revision is fine, changed rows or numbers need a new approval', async () => {
  const { bridge, approved, base } = await approvedBatch();
  const same = await recomputePlan(bridge, base, approved);
  assert.deepEqual(same, approved);
  // The approved dropdown additions (or anybody's edit elsewhere) give the workbook a new revision.
  const later = new Bridge(async (name, payload) => name === 'sheets-revision' ? reply({ revision: 43 }) : (bridge as any).run(name, payload));
  await failsWith(recomputeApiPlan(later, base, approved), /版本\/规则与获批计划变化/);
  const fresh = await recomputePlan(later, base, approved);
  assert.equal(fresh.api_plan.revision, 43);
  assert.deepEqual(fresh.batch_plan, approved.batch_plan);
  const moved = new Snapshot(path.join(fixtures, 'applied-complete.xlsx'));
  await failsWith(recomputePlan(bridge, moved, approved), /素材编号或名称与获批计划不同/);
  await failsWith(recomputePlan(bridge, base, { ...approved, batch_plan: { ...approved.batch_plan, range: 'A7:I9' } }), /获批计划被修改过/);
  await failsWith(recomputePlan(bridge, base, { batch_plan: approved.batch_plan }), /获批计划不完整/);
});

test('plan --output saves the whole plan and prints only what the user is shown, with the dropdown options to add', async () => {
  const { bridge } = await approvedBatch();
  const requestFile = path.join(fixtures, 'requests', 'basic.json');
  const out = path.join(tmp(), 'plan.json');
  const args = ['feishu', 'plan', '--request', requestFile, '--snapshot', path.join(fixtures, 'base.xlsx'), '--output', out];
  const { result, code } = await main(args, bridge);
  assert.equal(code, 0, JSON.stringify(result));
  assert.deepEqual(Object.keys(readJson(out)).sort(), ['api_plan', 'batch_plan']);
  assert.deepEqual([result.status, result.worksheet, result.sheet_id, result.range, result.first_number, result.last_number],
    ['plan_saved', 'GOFCN创意进度 26年3月', 's3', 'A6:I8', 1011, 1013]);
  assert.deepEqual(result.groups[0], { group: '01', quantity: 2, requirement_name: 'GOFCN1011-GOFCN1012', supplier: '供应商丙', reviewer: '张三',
    script_url: 'https://centurygames.feishu.cn/docx/ABC123def', message_kind: '玩法*2',
    items: [{ quantity: 2, first: 'GOFCN1011_玩法_卖点_视频_新爆点', last: 'GOFCN1012_玩法_卖点_视频_新爆点' }] });
  assert.deepEqual(result.new_options, [{ field: 'supplier', option: '供应商丙' }]);
  const again = await main(args, bridge);
  assert.deepEqual([again.code, again.result.reason], [2, '计划文件已存在，不覆盖']);
});

test('a plan of rows without a CLS ticket (finished materials) shows no requirement name, script link or group message', async () => {
  const { bridge } = await approvedBatch();
  const dir = tmp();
  const request = { groups: [{ supplier: '供应商丙', reviewer: '张三', primary_tag: '玩法', secondary_tag: '卖点', creative_form: '视频',
    items: [{ quantity: 1, keyword: '企鹅保龄球_竖版', material_name: 'GOFCNxxxxx_玩法_卖点_视频_企鹅保龄球_竖版' }] }] };
  fs.writeFileSync(path.join(dir, 'request.json'), JSON.stringify(request));
  const { result, code } = await main(['feishu', 'plan', '--request', path.join(dir, 'request.json'), '--snapshot', path.join(fixtures, 'base.xlsx'), '--output', path.join(dir, 'plan.json')], bridge);
  assert.equal(code, 0, JSON.stringify(result));
  assert.deepEqual(result.groups[0], { group: '01', quantity: 1, supplier: '供应商丙', reviewer: '张三',
    items: [{ quantity: 1, first: 'GOFCN1011_玩法_卖点_视频_企鹅保龄球_竖版', last: 'GOFCN1011_玩法_卖点_视频_企鹅保龄球_竖版' }] });
});

test('the plan shows each row\'s 提炼词 and says how many rows have none of their own (the default 关键词), for the user to confirm', async () => {
  const { bridge } = await approvedBatch();
  const dir = tmp(), cls = { direction: '方向一', task_type: 'creative_a' };
  // The 终稿库 example: each piece is headed "GOFCN56890 企鹅保龄球 V15", and the 国风配乐 version is a second 围炉煮冰 row.
  const request = { groups: [
    { supplier: '供应商丙', reviewer: '张三', script_url: 'https://centurygames.feishu.cn/docx/ABC123def', primary_tag: '玩法', secondary_tag: '卖点', creative_form: '视频', cls,
      items: [{ quantity: 1, keyword: '企鹅保龄球' }, { quantity: 1, keyword: '冻鱼飞盘' }, { quantity: 2, keyword: '围炉煮冰' }] },
    { supplier: '供应商甲', reviewer: '李四', script_url: 'https://centurygames.feishu.cn/wiki/XYZ789', primary_tag: '玩法', secondary_tag: '卖点', creative_form: '视频', quantity: 2, cls },
  ] };
  fs.writeFileSync(path.join(dir, 'request.json'), JSON.stringify(request));
  const { result, code } = await main(['feishu', 'plan', '--request', path.join(dir, 'request.json'), '--snapshot', path.join(fixtures, 'base.xlsx'), '--output', path.join(dir, 'plan.json')], bridge);
  assert.equal(code, 0, JSON.stringify(result));
  assert.deepEqual(result.groups[0].items.map((i: any) => [i.quantity, i.first, i.last]), [
    [1, 'GOFCN1011_玩法_卖点_视频_企鹅保龄球', 'GOFCN1011_玩法_卖点_视频_企鹅保龄球'], [1, 'GOFCN1012_玩法_卖点_视频_冻鱼飞盘', 'GOFCN1012_玩法_卖点_视频_冻鱼飞盘'],
    [2, 'GOFCN1013_玩法_卖点_视频_围炉煮冰', 'GOFCN1014_玩法_卖点_视频_围炉煮冰']]);
  assert.equal(result.groups[0].default_keyword_rows, undefined, 'every row has a 提炼词 of its own');
  assert.equal(result.groups[1].default_keyword_rows, 2);
  assert.equal(result.groups[1].items[0].first, 'GOFCN1015_玩法_卖点_视频_关键词');
});
