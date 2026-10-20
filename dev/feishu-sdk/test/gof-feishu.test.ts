import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRIDGE_VERSION, type BridgeReply } from '../src/bridge.ts';
import { status } from '../src/gof/batch.ts';
import { Bridge, OccupiedRefusal, SCOPES, apiPlan, document, execute, login, planWithApi, probe, reconcile, recomputeApiPlan } from '../src/gof/feishu.ts';
import { makePlan } from '../src/gof/plan.ts';
import { prepare, record } from '../src/gof/batch.ts';
import { acceptance } from '../src/gof/rules.ts';
import { seal } from '../src/gof/seal.ts';
import { Snapshot } from '../src/gof/snapshot.ts';
import { Blocked, NODE, readJson } from '../src/gof/util.ts';
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

test('bridge failures map to the refusals the workflow expects, and untrusted server text is never echoed', async () => {
  const cases: [BridgeReply, RegExp, any][] = [
    [failure('occupied'), /非空/, OccupiedRefusal],
    [failure('unknown_result'), /结果未知/, Blocked],
    [failure('auth_required', '飞书登录已过期，请重新授权'), /auth_required.*重新授权/, Blocked],
    [failure('scope_missing', '缺少权限：x'), /缺少权限/, Blocked],
    [failure('api', 'SECRET-SERVER-TEXT code=1'), /飞书接口调用失败/, Blocked],
  ];
  for (const [result, pattern, type] of cases) {
    const { bridge } = bridgeWith(() => result);
    const error = await failsWith(bridge.call('api-get', { path: '/open-apis/x' }), pattern, type);
    assert.ok(!error.message.includes('SECRET-SERVER-TEXT'));
  }
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

test('login commands pass through with bounded waits', async () => {
  const { bridge, calls } = bridgeWith(() => reply({ state: 'pending', retry_after_s: 5, expires_in_s: 200 }));
  assert.equal((await login(bridge, 'poll', { wait: 7 })).state, 'pending');
  assert.deepEqual(calls.at(-1)!.payload, { wait_ms: 7000 });
  await login(bridge, 'start', { probeScope: true });
  assert.deepEqual(calls.at(-1)!.payload, { extra_scopes: ['sheets:spreadsheet:create'] });
  await failsWith(login(bridge, 'poll', { wait: 51 }), /0 到 50/);
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

test('the in-process bridge answers local commands and enforces its own allowlist', async () => {
  const userDir = tmp();
  const bridge = new Bridge(undefined, { env: { LARK_AGENT_USER_DIR: userDir, FEISHU_APP_ID: 'cli_x', FEISHU_APP_SECRET: 'secret-000000' } });
  const info = await bridge.call('info');
  assert.deepEqual([info.bridge, info.storage], [BRIDGE_VERSION, 'host']);
  assert.deepEqual([(await bridge.call('auth-status')).logged_in], [false]);
  await failsWith(bridge.doctor(), /尚未授权/);
  await failsWith(bridge.call('api-get', { path: '/open-apis/im/v1/messages' }), /invalid_request/);
});

// ---- a whole append against a fake Feishu: plan → prepare → probe receipt → append → read back → reconcile

class FakeProduction {
  appended = false;
  productionWrites = 0;
  failWrite: BridgeReply | undefined;
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
      fs.copyFileSync(path.join(fixtures, this.appended ? 'applied-complete.xlsx' : 'base.xlsx'), payload.output, fs.constants.COPYFILE_EXCL);
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
      return reply({ applied: true });
    }
    return new FakeSheets().handle(name, payload);
  };

  private mainRules() {
    const rule = (items: string[], range: string) => ({ dataValidationType: 'list', conditionValues: items, ranges: [`s3!${range}`],
      options: { multipleValues: false, highlightValidData: false, colorValueMap: {} } });
    return [rule(['玩法', '画面', '系统'], 'D2:D500'), rule(['卖点', '体验'], 'E2:E500'), rule(['视频', '图文'], 'F2:F500'),
      rule(['供应商甲', '供应商乙'], 'H2:H5'), rule(['张三', '李四'], 'I2:I500'), ...this.extraRules];
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
  void document; void apiPlan; void makePlan;
});
