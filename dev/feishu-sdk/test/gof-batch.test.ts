import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Snapshot } from '../src/gof/snapshot.ts';
import { makePlan, type Plan } from '../src/gof/plan.ts';
import { normalizeRequest } from '../src/gof/request.ts';
import { clsCheck, loadBatch, message, preflight, prepare, record, report, status, verify } from '../src/gof/batch.ts';
import { Blocked, canonical, digest, readJson, writeJsonNew } from '../src/gof/util.ts';
import { rejectSecrets } from '../src/gof/seal.ts';

/*
 * The fixtures and golden.json were produced by the Python implementation this code replaced (dev/tests/make_fixtures.py in
 * the history before it was removed). Digests and plan ids are not comparable (they hash openpyxl's view of the workbook),
 * so everything else is: row ranges, numbers, names, CSV text, verdicts, reasons.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, 'fixtures');
const golden = readJson(path.join(fixtures, 'golden.json'));
const fx = (name: string) => path.join(fixtures, name);
const request = (name: string) => readJson(path.join(fixtures, 'requests', `${name}.json`));
const strip = (plan: Plan) => { const { plan_id, baseline_digest, ...rest } = plan; return rest; };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gof-batch-'));
const MAIN = 'GOFCN创意进度 26年3月';
// JSON.parse cannot tell 2.0 from 2, so the Python check for an integral float is not reproducible.
const KNOWN_DIVERGENT = new Set(['base.xlsx|float-quantity|']);
// Refusals whose rule changed after the port: 提炼词 defaults to 关键词 and the material name can be built from the tags, so only the
// fields that are really missing are named.
const CHANGED_REFUSALS: Record<string, string> = { 'base.xlsx|missing-field|': '第 1 组缺少需求字段：供应商' };

function open(name: string): Snapshot { return new Snapshot(fx(name)); }

test('plans match what the Python implementation produced, including the refusals', () => {
  const keys = [...Object.keys(golden.plan), ...Object.keys(golden.plan_errors)];
  assert.ok(keys.length >= 25);
  for (const key of keys) {
    if (KNOWN_DIVERGENT.has(key)) continue;
    const [fixture, req, current] = key.split('|') as [string, string, string];
    const snapshot = open(fixture);
    if (key in golden.plan) {
      const plan = makePlan(snapshot, request(req), current || null);
      assert.deepEqual(strip(plan), golden.plan[key], key);
      assert.match(plan.plan_id, /^[0-9a-f]{24}$/);
    } else {
      assert.throws(() => makePlan(snapshot, request(req), current || null), (error: Error) => {
        assert.ok(error instanceof Blocked, `${key}: ${error.stack}`);
        assert.equal(error.message, CHANGED_REFUSALS[key] ?? golden.plan_errors[key], key);
        return true;
      });
    }
  }
});

test('the fingerprint is stable for the same file and changes with any content, style, rule or layout change', () => {
  const a = open('base.xlsx').fingerprint;
  assert.equal(open('base.xlsx').fingerprint, a);
  for (const name of ['plan-protected.xlsx', 'plan-merged.xlsx', 'plan-no-formula.xlsx', 'applied-outside-style.xlsx', 'applied-rule-changed.xlsx',
    'applied-outside-comment.xlsx', 'applied-hidden-row.xlsx', 'applied-filter-changed.xlsx', 'applied-complete.xlsx']) {
    assert.notEqual(open(name).fingerprint, a, name);
  }
});

test('prepare writes the same CSV and clipboard text as before, refuses a second run and a stale plan', () => {
  const snapshot = open('base.xlsx');
  const plan = makePlan(snapshot, request('basic'));
  const root = tmp();
  const prepared = prepare(plan, snapshot, { outputRoot: root });
  assert.equal(prepared.range, golden.prepare.range);
  assert.deepEqual(prepared.csv, golden.prepare.csv);
  const dir = prepared.batch as string;
  assert.equal(path.basename(dir), plan.plan_id);
  for (const [name, text] of Object.entries<string>(golden.prepare.files)) {
    assert.equal(fs.readFileSync(path.join(dir, name), 'utf8'), text, name);
  }
  assert.ok(fs.readFileSync(path.join(dir, golden.prepare.csv[0]), 'utf8').startsWith('﻿脚本名称,脚本内容,创意标签\r\n'));
  assert.throws(() => prepare(plan, snapshot, { outputRoot: root }), /EEXIST/);
  const stale = { ...plan, first_number: plan.first_number + 1 };
  assert.throws(() => prepare(stale, snapshot, { outputRoot: tmp() }), (e: Error) => e.message === golden.prepare.stale_plan);
  assert.throws(() => prepare(plan, snapshot, { outputRoot: tmp(), workspace: tmp() }), /不能同时使用/);
  // Any change to a generated file is noticed.
  fs.appendFileSync(path.join(dir, 'append.tsv'), 'x');
  assert.throws(() => status(dir), /批次文件发生变化：append.tsv/);
});

function prepared() {
  const snapshot = open('base.xlsx');
  const plan = makePlan(snapshot, request('basic'));
  return { dir: prepare(plan, snapshot, { outputRoot: tmp() }).batch as string, plan };
}

test('verification gives the same verdicts as the Python implementation for every appended variant', () => {
  const { dir } = prepared();
  for (const [fixture, expected] of Object.entries<any>(golden.verify)) {
    const result = verify(dir, open(fixture));
    assert.equal(result.status, expected.status, fixture);
    assert.equal(result.matched_cells, expected.matched_cells, fixture);
    assert.equal(result.expected_cells, expected.expected_cells, fixture);
    if (fixture === 'applied-renamed-sheet.xlsx') {
      // Python reported an arbitrary 20 of many; the first message is the stable part.
      assert.equal(result.issues[0], expected.issues.find((i: string) => i.startsWith('工作表列表')));
      continue;
    }
    assert.deepEqual([...result.issues].sort(), [...expected.issues].sort(), fixture);
  }
});

test('preflight only lets an untouched snapshot through', () => {
  const { dir } = prepared();
  for (const [fixture, expected] of Object.entries<any>(golden.preflight)) {
    if (expected.status === 'blocked') assert.throws(() => preflight(dir, open(fixture)), (e: Error) => e.message === expected.reason, fixture);
    else assert.deepEqual(preflight(dir, open(fixture)), expected, fixture);
  }
});

test('the batch state machine accepts and refuses the same steps in the same words', () => {
  const root = tmp();
  const snapshot = open('base.xlsx');
  const plan = makePlan(snapshot, request('basic'));
  const dir = prepare(plan, snapshot, { outputRoot: root }).batch as string;
  const evidenceDir = tmp();
  let n = 0;
  const evidence = (value: unknown) => value;
  const run = (name: string, step: string, group?: string, ev?: unknown, fixture?: string) => {
    try {
      return record(dir, step, group ?? null, ev === undefined ? undefined : evidence(ev) as any, fixture ? open(fixture) : undefined);
    } catch (error) {
      assert.ok(error instanceof Blocked, `${name}: ${(error as Error).stack}`);
      return { status: 'blocked', reason: (error as Error).message };
    }
  };
  const mismatches: string[] = [];
  void evidenceDir; void n;
  const steps: Record<string, [string, string?, unknown?, string?]> = {
    'cls before append': ['cls_started', '01'],
    'secret in evidence': ['append_started', undefined, { access_token: 'x' }],
    'append_started': ['append_started'],
    'append_started twice': ['append_started'],
    'verified with partial': ['append_verified', undefined, {}, 'applied-partial.xlsx'],
    'verified without snapshot': ['append_verified'],
    'verified': ['append_verified', undefined, {}, 'applied-complete.xlsx'],
    'append_verified twice': ['append_verified', undefined, {}, 'applied-complete.xlsx'],
    'bad group': ['cls_started', '09'],
    'cls_started': ['cls_started', '01'],
    'cls_started twice': ['cls_started', '01'],
    'draft before attempt': ['draft_saved', '01', { confirmed: true, unpublished: true, url: 'https://creative.centurygames.cn/requirement/1/edit-outer' }],
    'draft bad url': ['draft_saved', '01', { confirmed: true, unpublished: true, url: 'https://evil.example.com/x' }],
    'handoff no reason': ['handoff', '01', {}],
    'bad requirement number': ['requirement_number', '01', { confirmed: true, requirement_number: 'GOFCN123' }],
    'blocked no reason': ['blocked', undefined, {}],
    'unknown step': ['frobnicate', '01', {}],
    'cls_started group 2': ['cls_started', '02'],
    'handoff group 2': ['handoff', '02', { reason: '人工接手' }],
    'handoff group 2 twice': ['handoff', '02', { reason: '再次' }],
    'number group 2': ['requirement_number', '02', { confirmed: true, requirement_number: 'GOFCN20260100001' }],
    'blocked': ['blocked', undefined, { reason: '测试阻塞' }],
    'record while blocked': ['handoff', '01', { reason: 'x' }],
    'resumed without confirm': ['resumed', undefined, { reason: 'x' }, 'applied-complete.xlsx'],
    'resumed': ['resumed', undefined, { confirmed: true, reason: '已核对', cls_reconciled: true }, 'applied-complete.xlsx'],
  };
  const expected = new Map<string, any>();
  for (const f of golden.flow) if (f.step !== undefined) expected.set(f.name, f.result);
  const states = new Map<string, any>(golden.flow.filter((f: any) => f.status).map((f: any) => [f.name, f.status]));
  const checkState = (name: string) => {
    const s = status(dir);
    assert.deepEqual({ append_verified: s.append_verified, blocked: s.blocked, groups: s.groups }, states.get(name), name);
  };
  for (const [name, [step, group, ev, fixture]] of Object.entries(steps)) {
    const got = run(name, step, group, ev, fixture);
    const want = expected.get(name);
    if (want === undefined) throw new Error(`no golden for ${name}`);
    if (want.status === 'blocked') assert.deepEqual(got, want, name);
    else assert.deepEqual(got, want, name);
    if (name === 'verified') checkState('after append_verified');
    if (name === 'blocked') checkState('after blocked');
    if (name === 'resumed') checkState('after resumed');
  }
  void mismatches;

  const observations: Record<string, any> = {
    fill: { logged_in: true, can_create: true, unpublished: true, save_result: 'ok' },
    publish: {},
    save_ok: { logged_in: true, can_create: true, unpublished: true, save_result: 'ok', required_complete: true },
    save_incomplete: { logged_in: true, can_create: true, unpublished: true, save_result: 'ok' },
    save_loggedout: { logged_in: false, can_create: true, unpublished: true, required_complete: true },
    save_unknown: { logged_in: true, can_create: true, unpublished: true, save_result: 'unknown', required_complete: true },
    import: { logged_in: true, can_create: true, unpublished: true, save_result: 'ok' },
  };
  const checks = golden.flow.filter((f: any) => f.name.startsWith('cls-check') && f.name !== 'cls-check bad group');
  const wanted = [['fill', 'fill'], ['publish', 'publish'], ['save_draft', 'save_ok'], ['save_draft', 'save_incomplete'], ['save_draft', 'save_loggedout'],
    ['save_draft', 'save_unknown'], ['import_scripts', 'import']] as const;
  wanted.forEach(([action, key], i) => {
    const want = checks[i].result;
    try {
      assert.deepEqual(clsCheck(dir, '01', action, observations[key]), want, `${action}/${key}`);
    } catch (error) {
      if (!(error instanceof Blocked)) throw error;
      assert.deepEqual({ status: 'blocked', reason: error.message }, want, `${action}/${key}`);
    }
  });
  assert.throws(() => clsCheck(dir, '09', 'save_draft', {}), (e: Error) => e.message === '组不存在');

  const want = golden.flow.find((f: any) => f.name === 'message').result;
  assert.deepEqual(message(dir), want);
  const full = report(dir);
  assert.equal(full.status, 'report_ready');
  const body = golden.flow.find((f: any) => f.name === 'report body').result;
  for (const key of ['status', 'worksheet', 'range', 'target', 'message']) assert.deepEqual(full[key], body[key], key);
  assert.deepEqual(full.groups.map((g: any) => ({ group: g.group, quantity: g.quantity, steps: g.steps })),
    golden.flow.find((f: any) => f.name === 'report groups').result);
  assert.equal(loadBatch(dir).manifest.plan.plan_id, plan.plan_id);
});

test('the event chain notices a changed or missing event', () => {
  const { dir } = prepared();
  record(dir, 'append_started', null);
  record(dir, 'blocked', null, { reason: '测试' });
  const file = path.join(dir, 'events', '000001.json');
  const original = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, original.replace('append_started', 'append_verified'));
  assert.throws(() => status(dir), /批次事件被修改/);
  fs.writeFileSync(file, original);
  fs.renameSync(file, path.join(dir, 'events', '000009.json'));
  assert.throws(() => status(dir), /批次事件缺失\/排序异常/);
});

test('canonical JSON and digests agree with Python byte for byte, which the browser-side CLS adapter relies on', () => {
  for (const sample of golden.canonical) {
    assert.equal(canonical(sample.value), sample.canonical);
    assert.equal(digest(sample.value), sample.sha256);
  }
});

test('records that carry credentials are refused', () => {
  for (const [name, reason] of Object.entries<string>(golden.seal)) {
    const values: Record<string, unknown> = {
      key: { access_token: 'x' }, bearer: { a: 'Bearer abc' }, nested: { a: [{ Cookie: 'c' }] }, ok: { a: 'bearer' },
      'session-id-token': { id_token: 1 }, authz: { Authorization: 'x' },
    };
    if (reason === 'ok') assert.doesNotThrow(() => rejectSecrets(values[name]), name);
    else assert.throws(() => rejectSecrets(values[name]), (e: Error) => e.message === reason, name);
  }
});

test('JSON files are written exclusively and never over an existing file', () => {
  const file = path.join(tmp(), 'x.json');
  writeJsonNew(file, { a: 1 });
  assert.throws(() => writeJsonNew(file, { a: 2 }), /EEXIST/);
  assert.equal(readJson(file).a, 1);
  void MAIN;
});

test('a GOFCN sheet with an unusable header is never skipped silently: it stops the plan when it may be the target or hold higher numbers', () => {
  for (const fixture of ['plan-header-dup.xlsx', 'plan-no-header.xlsx']) {
    assert.throws(() => makePlan(open(fixture), request('basic'), null), (error: Error) => {
      assert.ok(error instanceof Blocked, fixture);
      assert.match(error.message, /不能静默跳过/, fixture);
      return true;
    }, fixture);
  }
});

// ---- requests the agent builds from a requirement document: 提炼词 by default, names built from the tags, rows of several kinds

const derived = (over: Record<string, unknown> = {}) => ({
  supplier: '供应商甲', reviewer: '张三', script_url: 'https://centurygames.feishu.cn/wiki/XYZ789?sheet=abc123',
  cls: { direction: '方向一', task_type: 'creative_a' }, ...over,
});

test('提炼词 defaults to 关键词 and the material name is built from the tags, form and keyword', () => {
  const plan = makePlan(open('base.xlsx'), { groups: [derived({ quantity: 2, primary_tag: '玩法', secondary_tag: '卖点', creative_form: '视频' })] });
  assert.deepEqual(plan.rows.map((r: Plan) => r.name), ['GOFCN1011_玩法_卖点_视频_关键词', 'GOFCN1012_玩法_卖点_视频_关键词']);
  const g = plan.groups[0].request;
  assert.deepEqual([g.keyword, g.material_name, g.topic, 'items' in g], ['关键词', '玩法_卖点_视频_关键词', '玩法_卖点', false]);
  // Written out in full, the same request gives the same plan.
  const same = makePlan(open('base.xlsx'), { groups: [derived({ quantity: 2, material_name: 'GOFCN1_玩法_卖点_视频_关键词', creative_form: '视频', keyword: '关键词' })] });
  assert.deepEqual(same, plan);
  // A one-item list is the same group too.
  const listed = makePlan(open('base.xlsx'), { groups: [derived({ items: [{ quantity: 2, primary_tag: '玩法', secondary_tag: '卖点', creative_form: '视频' }] })] });
  assert.deepEqual(listed, plan);
});

test('a group can hold rows of several kinds: they keep their order, share one CSV and one CLS ticket, and are counted by kind', () => {
  const request = { groups: [derived({
    primary_tag: '玩法', creative_form: '视频',
    items: [{ quantity: 2, secondary_tag: '卖点' }, { quantity: 1, secondary_tag: '体验', keyword: '新词' }, { quantity: 1, secondary_tag: '卖点' },
      { quantity: 1, primary_tag: '画面', secondary_tag: '体验', creative_form: '图文' }],
  })] };
  const snapshot = open('base.xlsx');
  const plan = makePlan(snapshot, request);
  assert.equal(plan.range, 'A6:I10');
  assert.deepEqual(plan.rows.map((r: Plan) => r.name), ['GOFCN1011_玩法_卖点_视频_关键词', 'GOFCN1012_玩法_卖点_视频_关键词',
    'GOFCN1013_玩法_体验_视频_新词', 'GOFCN1014_玩法_卖点_视频_关键词', 'GOFCN1015_画面_体验_图文_关键词']);
  assert.deepEqual(plan.rows.map((r: Plan) => [r.values[`B${r.row}`], r.values[`E${r.row}`], r.values[`H${r.row}`], r.values[`I${r.row}`]]),
    [['关键词', '卖点', '供应商甲', '张三'], ['关键词', '卖点', '供应商甲', '张三'], ['新词', '体验', '供应商甲', '张三'],
      ['关键词', '卖点', '供应商甲', '张三'], ['关键词', '体验', '供应商甲', '张三']]);
  assert.equal(plan.groups.length, 1);
  assert.equal(plan.groups[0].request.quantity, 5);
  // prepare makes the plan again from the normalized request, which must come out the same.
  assert.deepEqual(normalizeRequest(plan.request), plan.request);
  assert.deepEqual(plan.dropdowns.find((d: Plan) => d.field === 'secondary_tag').missing, []);
  const dir = prepare(plan, snapshot, { outputRoot: tmp() }).batch as string;
  const csv = fs.readFileSync(path.join(dir, plan.groups[0].csv), 'utf8');
  assert.equal(csv.split('\r\n').length, 7);
  assert.ok(csv.includes('GOFCN1011_玩法_卖点_视频_关键词,https://centurygames.feishu.cn/wiki/XYZ789?sheet=abc123,'));
  assert.ok(csv.includes('GOFCN1015_画面_体验_图文_关键词,同上,'));
  assert.ok((message(dir).message as string).includes('（玩法_卖点 · 视频 * 3，玩法_体验 · 视频 * 1，画面_体验 · 图文 * 1）'));
});

test('a request with rows of several kinds is refused when an item is incomplete or the group also counts its own rows', () => {
  const refused = (group: Record<string, unknown>) => {
    try { makePlan(open('base.xlsx'), { groups: [derived(group)] }); } catch (error) { assert.ok(error instanceof Blocked); return error.message; }
    return 'no error';
  };
  const item = { quantity: 1, primary_tag: '玩法', secondary_tag: '卖点', creative_form: '视频' };
  assert.equal(refused({ quantity: 2, items: [item] }), '第 1 组的 quantity 与各项数量之和不一致');
  assert.equal(refused({ material_name: '玩法_卖点_视频_关键词', items: [item] }), '第 1 组已按 items 分行，素材名称写在各项里');
  assert.equal(refused({ items: [] }), '第 1 组的 items 需要至少一项');
  assert.equal(refused({ items: [item, { ...item, extra: 1 }] }), '第 1 组第 2 项有未知字段');
  assert.equal(refused({ items: [item, { quantity: 1, primary_tag: '玩法', creative_form: '视频' }] }), '第 1 组第 2 项缺少一级/二级标签');
  assert.equal(refused({ items: [item, { quantity: 1, primary_tag: '玩法', secondary_tag: '卖点' }] }), '第 1 组第 2 项缺少创意形式');
  assert.equal(refused({ items: [{ ...item, quantity: 0 }] }), 'quantity 必须是正整数');
  assert.equal(refused({ items: [{ ...item, material_name: '玩法_卖点_图文_关键词' }] }), '素材名称与创意形式/提炼词不一致，请澄清');
  assert.equal(refused({ quantity: 1, creative_form: '视频' }), '第 1 组缺少一级/二级标签');
  assert.equal(refused({ ...item, script_url: 'https://centurygames.feishu.cn/sheets/shtABC123?sheet=x' }), 'no error');
});
