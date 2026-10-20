import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepare, record, status, report, message } from '../src/gof/batch.ts';
import { createClsAdapter } from '../src/gof/cls-adapter.ts';
import { clsPreview, operation, requirementName } from '../src/gof/cls.ts';
import { makePlan } from '../src/gof/plan.ts';
import { Snapshot } from '../src/gof/snapshot.ts';
import { Blocked, readJson, writeJsonNew } from '../src/gof/util.ts';
import { main } from '../src/gof/cli.ts';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const golden = readJson(path.join(fixtures, 'golden.json')).cls;
const catalog = readJson(path.join(fixtures, 'catalog.json'));
const request = readJson(path.join(fixtures, 'requests', 'basic.json'));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gof-cls-'));
const reason = (fn: () => unknown): string => {
  try { fn(); } catch (error) { assert.ok(error instanceof Blocked, (error as Error).stack); return error.message; }
  return 'no error';
};

test('the CLS preview builds the payloads the Python implementation built, and refuses what it refused', () => {
  assert.deepEqual(clsPreview(request, catalog), golden.preview);
  const variants: Record<string, (c: any) => void> = {
    'no-create': c => { c.can_create = false; },
    'no-game-permission': c => { c.account.game_ids = [4]; },
    'unknown-supplier': c => { c.users.splice(1, 1); },
    'dup-direction': c => { c.directions.push({ id: 23, name: '方向一', game_id: 3 }); },
    secret: c => { c.authorization = 'x'; },
  };
  for (const [name, change] of Object.entries(variants)) {
    const broken = structuredClone(catalog);
    change(broken);
    assert.equal(reason(() => clsPreview(request, broken)), golden[`preview-${name}`].reason, name);
  }
  const quote = structuredClone(request);
  quote.groups[1].cls.quotation = 'abc';
  assert.equal(reason(() => clsPreview(quote, catalog)), golden['preview-bad-quote'].reason);
});

function groupReady() {
  const base = new Snapshot(path.join(fixtures, 'base.xlsx'));
  const dir = prepare(makePlan(base, request), base, { outputRoot: tmp() }).batch as string;
  const applied = new Snapshot(path.join(fixtures, 'applied-complete.xlsx'));
  record(dir, 'append_started', null);
  record(dir, 'append_verified', null, {}, applied);
  record(dir, 'cls_started', '01');
  return dir;
}

const observations = { logged_in: true, can_create: true, unpublished: true, save_result: 'ok', required_complete: true };

function receiptFor(op: any, over: Record<string, any> = {}) {
  const parent: Record<string, any> = { id: 5001, status: -2, user_id: op.account_id, for_internal: 0, sub_scripts: [], number: 'GOFCN20260100009' };
  for (const [key, value] of Object.entries<any>(op.payload)) if (key !== 'asset_data') parent[key] = value === '' && key.endsWith('_date') ? null : value;
  return {
    schema: 1, transport: 'cls_api', status: 'verified', unpublished: true, parent, operation_id: op.operation_id, action: op.action,
    calls: [{ method: 'POST', path: '/api/workflow/script/save', http_status: 200, business_code: 0 },
      { method: 'GET', path: '/api/workflow/script/5001', http_status: 200, business_code: 0 }],
    ...over,
  };
}

test('an operation and its receipts are checked as strictly as before', () => {
  const dir = groupReady();
  const opPath = path.join(dir, 'save-operation.json');
  const op = operation(dir, '01', 'save_draft', catalog, observations);
  writeJsonNew(opPath, op);
  assert.match(op.operation_id, /^[0-9a-f]{64}$/);
  const body = Object.fromEntries(['schema', 'action', 'group', 'account_id', 'payload', 'native_defaults', 'expected'].map(k => [k, op[k]]));
  assert.deepEqual(body, golden.operation_save_body);
  assert.equal(reason(() => operation(dir, '01', 'import_scripts', catalog, observations)), golden.operation_import_before_draft.reason);

  const draft = (name: string, receipt: unknown, evidence: Record<string, any> = {}) => {
    const file = path.join(dir, `receipt-${name}.json`);
    fs.writeFileSync(file, JSON.stringify(receipt));
    return reason(() => record(dir, 'draft_saved', '01', {
      confirmed: true, unpublished: true, transport: 'cls_api', draft_id: 5001, operation: opPath, receipt: file,
      url: 'https://creative.centurygames.cn/requirement/5001/edit-outer', ...evidence,
    }));
  };
  assert.equal(draft('no-attempt', receiptFor(op)), golden['draft-no-attempt'].reason);
  record(dir, 'cls_api_attempt', '01', { action: 'save_draft', operation_id: op.operation_id, observations });
  const parent = receiptFor(op).parent;
  const cases: [string, unknown, Record<string, any>?][] = [
    ['wrong-operation', receiptFor(op, { operation_id: '0'.repeat(64) })],
    ['wrong-name', receiptFor({ ...op, payload: { ...op.payload, name: '别的' } })],
    ['scripts-in-draft', receiptFor(op, { parent: { ...parent, sub_scripts: [{ id: 1 }] } })],
    ['bad-call', receiptFor(op, { calls: [{ method: 'POST', path: '/api/workflow/script/publish', http_status: 200, business_code: 0 }] })],
    ['not-draft', receiptFor(op, { parent: { ...parent, status: 1 } })],
    ['wrong-url', receiptFor(op), { url: 'https://creative.centurygames.cn/requirement/9/edit-outer' }],
    ['wrong-number', receiptFor(op), { requirement_number: 'GOFCN20260100001' }],
    ['wrong-price', receiptFor(op, { parent: { ...parent, price: 3 } })],
  ];
  for (const [name, receipt, evidence] of cases) assert.equal(draft(name, receipt, evidence), golden[`draft-${name}`].reason, name);
  assert.throws(() => record(dir, 'draft_saved', '01', {
    confirmed: true, unpublished: true, transport: 'cls_api', draft_id: 5001, operation: opPath, receipt: path.join(dir, 'receipt-none.json'),
    url: 'https://creative.centurygames.cn/requirement/5001/edit-outer',
  }), /ENOENT/);
  assert.equal(draft('ok', receiptFor(op), { requirement_number: 'GOFCN20260100009' }), 'no error');
  assert.deepEqual(status(dir).groups['01'], golden.steps_group_01);
  assert.ok((message(dir).message as string).includes('GOFCN20260100009（玩法_卖点 · 视频 * 2）'));
  const full = report(dir);
  assert.equal(full.groups[0].draft_saved.draft_id, 5001);
  // The operation file is never replaced.
  assert.throws(() => writeJsonNew(opPath, op), /EEXIST/);
});

test('the adapter checks an operation built here (same canonical form and digest) before it sends anything', async () => {
  const dir = groupReady();
  const op = operation(dir, '01', 'save_draft', catalog, observations);
  const adapter = createClsAdapter({ origin: 'https://creative.centurygames.cn', authorization: 'Bearer test', fetch: async () => { throw new Error('no network'); } });
  // createDraft validates the operation before any request: a wrong digest is refused, a right one gets as far as the catalog read, which has no network here.
  await assert.rejects(() => adapter.createDraft({ ...op, operation_id: '0'.repeat(64) }), /操作文件摘要错误/);
  await assert.rejects(() => adapter.createDraft(op), /CLS 读取失败/);
});

test('the cls command line builds and saves an operation file', async () => {
  const dir = groupReady();
  const obs = path.join(dir, 'obs.json');
  fs.writeFileSync(obs, JSON.stringify(observations));
  const out = path.join(dir, 'op.json');
  const { result, code } = await main(['cls', '--batch', dir, '--group', '01', '--action', 'save_draft', '--catalog', path.join(fixtures, 'catalog.json'),
    '--observations', obs, '--output', out]);
  assert.equal(code, 0, JSON.stringify(result));
  assert.equal(result.status, 'operation_ready');
  assert.equal(readJson(out).operation_id, result.operation_id);
  const again = await main(['cls', '--batch', dir, '--group', '01', '--action', 'save_draft', '--catalog', path.join(fixtures, 'catalog.json'),
    '--observations', obs, '--output', out]);
  assert.deepEqual([again.code, again.result.reason], [2, golden.operation_exists.reason]);
});

test('the CLS requirement name is the first and last material number of the group, and is never taken from the request', () => {
  assert.equal(requirementName(['GOFCN67294_a', 'GOFCN67295_a', 'GOFCN67299_a']), 'GOFCN67294-GOFCN67299');
  assert.equal(requirementName(['GOFCN67294_a']), 'GOFCN67294');
  assert.equal(reason(() => requirementName(['无编号'])), '素材名称缺少 GOFCN 编号，无法生成需求名称');
  const given = structuredClone(request);
  given.groups[0].cls.requirement_name = '手填';
  assert.equal(reason(() => clsPreview(given, catalog)), 'CLS 需求名称由该组素材编号生成（GOFCN首号-GOFCN末号），不接受输入');
});
