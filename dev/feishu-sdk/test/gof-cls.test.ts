import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepare, record, status, report, message } from '../src/gof/batch.ts';
import { createClsAdapter } from '../src/gof/cls-adapter.ts';
import { catalogChoices, clsPreview, operation, requirementName } from '../src/gof/cls.ts';
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
  const preview = clsPreview(request, catalog);
  // The CLS names everything was matched to are new since the port; the rest is unchanged.
  assert.deepEqual(preview.groups.map((g: any) => g.cls_names), [
    { direction: '方向一', task_type: 'creative_a', supplier: '丙公司（供应商丙）', creator: '张三' },
    { direction: '方向一', task_type: 'creative_a', supplier: '供应商甲', creator: '李四' }]);
  assert.deepEqual({ ...preview, groups: preview.groups.map(({ cls_names, ...g }: any) => g) }, golden.preview);
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
  // The group with the saved draft is in the message with its official number; the other one has no ticket yet and is left out.
  const sent = message(dir);
  assert.ok((sent.message as string).includes('需求编号：GOFCN20260100009（玩法*2）\n供应商：供应商丙\n创意人：张三\n辛苦安排一下~'));
  assert.deepEqual([sent.skipped_groups, sent.missing_numbers], [['02'], []]);
  const full = report(dir);
  assert.equal(full.groups[0].draft_saved.draft_id, 5001);
  // The user is handed the progress sheet and each saved draft to look at.
  assert.deepEqual(full.links, { progress_sheet: 'https://centurygames.feishu.cn/wiki/YFyywzwLsiT07EkpBaecr8nIncn',
    cls: [{ group: '01', draft: 'https://creative.centurygames.cn/requirement/5001/edit-outer' }, { group: '02', draft: null }] });
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

test('CLS names are found from the short names the progress sheet uses, and exactly one may match', () => {
  const wide = structuredClone(catalog);
  wide.users.push(
    { id: 21, name: '北京柒曦文化传媒有限公司（丁杰）', roles: ['outsource'], status: 1 },
    { id: 22, name: '某某工作室（个体工商户）-杨燃', roles: ['outsource'], status: 1 },
    { id: 23, name: '达治（武汉）文化传媒有限公司', roles: ['outsource'], status: 1 },
    { id: 24, name: '长沙廿拾一文化传媒有限公司', roles: ['outsource'], status: 1 },
    { id: 25, name: '冯彦蓉-实习生', roles: ['creative_plan'], status: 1 },
    { id: 26, name: '张三丰', roles: ['creative_plan'], status: 1 },
    { id: 27, name: '李达甲', roles: ['creative_plan'], status: 1 },
    { id: 28, name: '李达乙', roles: ['creative_plan'], status: 1 },
    { id: 29, name: '丁杰-离职', roles: ['outsource'], status: 0 },
  );
  const names = (supplier: string, reviewer: string, cls: Record<string, string> = {}) => {
    const r = structuredClone(request);
    Object.assign(r.groups[0], { supplier, reviewer });
    Object.assign(r.groups[0].cls, cls);
    return clsPreview(r, wide).groups[0].cls_names;
  };
  assert.deepEqual(names('丁杰', '冯彦蓉'), { direction: '方向一', task_type: 'creative_a', supplier: '北京柒曦文化传媒有限公司（丁杰）', creator: '冯彦蓉-实习生' });
  assert.equal(names('杨燃', '张三').supplier, '某某工作室（个体工商户）-杨燃');
  assert.equal(names('达治', '张三').supplier, '达治（武汉）文化传媒有限公司');
  // The exact name wins over a longer one that contains it.
  assert.equal(names('供应商甲', '张三').creator, '张三');
  assert.equal(reason(() => names('供应商甲', '李达')), '创意人 不存在或匹配不唯一，需在计划前澄清');
  assert.equal(reason(() => names('廿十一', '张三')), '供应商 不存在或匹配不唯一，需在计划前澄清');
  // When the spelling differs, the request names the CLS user exactly; then nothing else is tried.
  assert.equal(names('廿十一', '李达', { supplier: '长沙廿拾一文化传媒有限公司', creator: '李达甲' }).creator, '李达甲');
  assert.equal(reason(() => names('丁杰', '张三', { supplier: '丁杰' })), '供应商 不存在或匹配不唯一，需在计划前澄清');
  const r = structuredClone(request);
  r.groups[0].cls.supplier = '长沙廿拾一文化传媒有限公司';
  const payload = clsPreview(r, wide).groups[0].payload;
  assert.equal(payload.third_user_id, 24);
  assert.ok(!('supplier' in payload) && !('creator' in payload));
});

test('the catalog choices are the GOFCN directions, creative task types, active suppliers and active people', () => {
  assert.deepEqual(catalogChoices(catalog), { directions: ['方向一'], task_types: ['creative_a'], suppliers: ['丙公司（供应商丙）', '供应商甲'], people: ['张三', '李四'] });
});
