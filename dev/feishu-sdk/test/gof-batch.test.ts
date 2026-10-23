import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Snapshot } from '../src/gof/snapshot.ts';
import { makePlan, type Plan } from '../src/gof/plan.ts';
import { normalizeRequest } from '../src/gof/request.ts';
import { clsCheck, composeMessage, loadBatch, message, NO_TICKET, preflight, prepare, record, report, status, verify } from '../src/gof/batch.ts';
import { operation } from '../src/gof/cls.ts';
import { Blocked, canonical, digest, readJson, writeJsonNew } from '../src/gof/util.ts';
import { rejectSecrets } from '../src/gof/seal.ts';
import { sameNameRows, variantRows } from '../src/gof/feishu.ts';
import { makeXlsx } from './helpers/xlsx-writer.ts';

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
// `naming` (how the sheet names a row, shown in the plan) came after the port.
const strip = (plan: Plan) => { const { plan_id, baseline_digest, naming, ...rest } = plan; return rest; };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gof-batch-'));
const MAIN = 'GOFCN创意进度 26年3月';
// JSON.parse cannot tell 2.0 from 2, so the Python check for an integral float is not reproducible.
const KNOWN_DIVERGENT = new Set(['base.xlsx|float-quantity|']);
// Refusals whose rule changed after the port: 设计师供应商 may be left open, but not in one group of a batch and not the other.
const CHANGED_REFUSALS: Record<string, string> = { 'base.xlsx|missing-field|': '这一批有的需求写了设计师供应商、有的没写（追加时一列一次写完，不能留空；供应商就是审核人本人时那格留空）：分两次追加' };
// No longer refused: a sheet without a naming formula to copy gets the sheet's naming written by the plan.
const NOW_PLANNED = new Set(['plan-no-formula.xlsx|basic|']);

function open(name: string): Snapshot { return new Snapshot(fx(name)); }

test('plans match what the Python implementation produced, including the refusals', () => {
  const keys = [...Object.keys(golden.plan), ...Object.keys(golden.plan_errors)];
  assert.ok(keys.length >= 25);
  for (const key of keys) {
    if (KNOWN_DIVERGENT.has(key)) continue;
    const [fixture, req, current] = key.split('|') as [string, string, string];
    const snapshot = open(fixture);
    if (NOW_PLANNED.has(key)) {
      const { rows } = makePlan(snapshot, request(req), current || null);
      assert.deepEqual([rows[0].name, rows[0].values.C6], ['GOFCN1011_玩法_卖点_视频_新爆点', '=SUBSTITUTE(CONCATENATE("GOFCN",A6,"_",D6,"_",E6,"_",F6,"_",B6),"__","_")'], key);
      continue;
    }
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

test('prepare writes the same CSV and clipboard text as before, starts a batch of its own when run again, and refuses a stale plan', () => {
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
  // The same plan again (only possible on an unchanged sheet: nothing of the first batch landed) never reuses the first batch's directory.
  const second = prepare(plan, snapshot, { outputRoot: root }).batch as string;
  assert.equal(path.basename(second), `${plan.plan_id}-2`);
  assert.equal(status(second).events.length, 0);
  assert.equal(loadBatch(dir).path, dir, 'the first one is left as it was');
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

test('提炼词 defaults to 关键词 and the material name is what the sheet\'s naming formula makes of the tags, form and keyword', () => {
  const plan = makePlan(open('base.xlsx'), { groups: [derived({ quantity: 2, primary_tag: '玩法', secondary_tag: '卖点', creative_form: '视频' })] });
  assert.deepEqual(plan.rows.map((r: Plan) => r.name), ['GOFCN1011_玩法_卖点_视频_关键词', 'GOFCN1012_玩法_卖点_视频_关键词']);
  assert.equal(plan.naming, 'GOFCN<素材编号>_<一级标签>_<二级标签>_<创意形式>_<提炼词>');
  const g = plan.groups[0].request;
  assert.deepEqual([g.keyword, g.material_name, g.topic, 'items' in g], ['关键词', undefined, '玩法_卖点', false]);
  // Written out in full, the same request gives the same rows; the name it gives is kept, to be checked against the formula.
  const same = makePlan(open('base.xlsx'), { groups: [derived({ quantity: 2, material_name: 'GOFCN1_玩法_卖点_视频_关键词', creative_form: '视频', keyword: '关键词' })] });
  assert.deepEqual([same.rows, same.groups[0].request.material_name], [plan.rows, '玩法_卖点_视频_关键词']);
  // A one-item list is the same group too.
  const listed = makePlan(open('base.xlsx'), { groups: [derived({ items: [{ quantity: 2, primary_tag: '玩法', secondary_tag: '卖点', creative_form: '视频' }] })] });
  assert.deepEqual(listed, plan);
  // The 素材名称 is the creative's name in CLS too, which cannot hold / or \: such a row could never be uploaded.
  for (const keyword of ['横版/竖版', 'A\\B']) {
    assert.throws(() => makePlan(open('base.xlsx'), { groups: [derived({ quantity: 1, primary_tag: '玩法', secondary_tag: '卖点', creative_form: '视频', keyword })] }), /不能含 \/ 或 \\/);
  }
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
  // Without a label the message counts the rows by 一级标签, in the order they first appear.
  assert.equal(composeMessage(plan.groups, [{ group: '01', step: 'handoff', evidence: {} }]).message.split('\n')[1],
    '需求编号：【发布后补填需求编号】（玩法*4，画面*1）');
});

// ---- the group message of a batch with one or several requirement documents

const kind = (label: string | undefined, quantity: number, supplier: string, reviewer: string, form = '视频') =>
  derived({ supplier, reviewer, quantity, primary_tag: '玩法', secondary_tag: '卖点', creative_form: form, ...(label ? { label } : {}) });
const numbered = (...entries: [string, string][]) => entries.map(([group, number]) => ({ group, step: 'requirement_number', evidence: { requirement_number: number } }));

test('several requirement documents give one message: every requirement with its supplier, then each creator once', () => {
  const plan = makePlan(open('base.xlsx'), { groups: [
    kind('迭代', 22, '潘越', '张天伟'), kind('素人剧情', 25, '丁杰', '张天伟'), kind('明星', 25, '丁杰', '雷佳威'), kind('解说', 25, '王晨龙', '雷佳威', '2D'),
  ] });
  const got = composeMessage(plan.groups, numbered(['01', 'GOFCN20250919001'], ['02', 'GOFCN20250919002'], ['03', 'GOFCN20250919003'], ['04', 'GOFCN20250919004']));
  assert.deepEqual(got, { status: 'message_ready', skipped_groups: [], missing_numbers: [], message: [
    '老师好 刚刚发了新的工单',
    '需求编号：GOFCN20250919001（迭代*22）', '供应商：潘越',
    '需求编号：GOFCN20250919002（素人剧情*25）', '供应商：丁杰',
    '需求编号：GOFCN20250919003（明星*25）', '供应商：丁杰',
    '需求编号：GOFCN20250919004（解说*25）', '供应商：王晨龙',
    '创意人：张天伟/雷佳威',
    '辛苦安排一下~',
  ].join('\n') });
});

test('one requirement gets the same wording, and a missing official number keeps the placeholder', () => {
  const plan = makePlan(open('base.xlsx'), { groups: [kind('素人剧情', 25, '丁杰', '张天伟')] });
  const got = composeMessage(plan.groups, [{ group: '01', step: 'draft_saved', evidence: {} }]);
  assert.equal(got.message, ['老师好 刚刚发了新的工单', '需求编号：【发布后补填需求编号】（素人剧情*25）', '供应商：丁杰', '创意人：张天伟', '辛苦安排一下~'].join('\n'));
  assert.deepEqual([got.status, got.missing_numbers, got.skipped_groups], ['message_ready', ['01'], []]);
});

test('a requirement without a ticket is left out of the message and named; with no ticket at all there is no message', () => {
  const plan = makePlan(open('base.xlsx'), { groups: [kind('明星', 3, '丁杰', '张天伟'), kind('解说', 2, '王晨龙', '雷佳威')] });
  const some = composeMessage(plan.groups, numbered(['02', 'GOFCN20250919002']));
  assert.deepEqual([some.skipped_groups, some.missing_numbers], [['01'], []]);
  assert.ok(!some.message.includes('明星') && some.message.includes('需求编号：GOFCN20250919002（解说*2）') && some.message.includes('创意人：雷佳威'));
  // Only a saved draft, a hand-over or an official number counts; starting the CLS stage does not.
  const none = composeMessage(plan.groups, [{ group: '01', step: 'cls_started', evidence: {} }, { group: null, step: 'append_verified', evidence: {} }]);
  assert.deepEqual(none, { status: 'message_not_ready', message: null, skipped_groups: ['01', '02'], missing_numbers: [] });
});

test('the label of a group is a short plain name; it is optional and survives normalizing again', () => {
  const plan = makePlan(open('base.xlsx'), { groups: [kind('素人剧情', 2, '丁杰', '张三')] });
  assert.equal(plan.groups[0].request.label, '素人剧情');
  assert.deepEqual(normalizeRequest(plan.request), plan.request);
  assert.ok(!('label' in makePlan(open('base.xlsx'), { groups: [kind(undefined, 2, '丁杰', '张三')] }).groups[0].request));
  for (const bad of ['', '  ', '素人（剧情）', '明星*2', 'a\nb', 'x'.repeat(21)]) {
    assert.throws(() => normalizeRequest({ groups: [{ ...kind(undefined, 2, '丁杰', '张三'), label: bad }] }), (e: Error) => e instanceof Blocked && /label/.test(e.message), JSON.stringify(bad));
  }
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
  assert.equal(refused({ items: [item, { quantity: 1, primary_tag: '玩法', secondary_tag: '卖点' }] }),
    '这一批有的行写了创意形式、有的没写（追加时一列一次写完，不能留空）：都不写创意形式、把它放在提炼词前面（素材名称不变），或分两次追加');
  // No 创意形式 at all is fine: the formula then gets SUBSTITUTE(…,"__","_") around it.
  assert.equal(refused({ items: [{ quantity: 1, primary_tag: '玩法', secondary_tag: '卖点' }] }), 'no error');
  assert.equal(refused({ items: [{ ...item, secondary_tag: '卖点_体验' }] }), '第 1 组第 1 项的二级标签“卖点_体验”不能含 _：素材名称按 _ 分段，标签和创意形式各占一段，其余写进提炼词');
  assert.equal(refused({ items: [{ ...item, creative_form: '3D_AI' }] }), '第 1 组第 1 项的创意形式“3D_AI”不能含 _：素材名称按 _ 分段，标签和创意形式各占一段，其余写进提炼词');
  for (const keyword of ['_企鹅', '企鹅_', '企鹅__竖版']) {
    assert.equal(refused({ items: [{ ...item, keyword }] }), `第 1 组第 1 项的提炼词“${keyword}”不能以 _ 开头或结尾，也不能有连续的 _`);
  }
  assert.equal(refused({ items: [{ ...item, quantity: 0 }] }), 'quantity 必须是正整数');
  assert.equal(refused({ items: [{ ...item, material_name: '玩法_卖点_图文_关键词' }] }),
    '按进度表的命名（GOFCN<素材编号>_<一级标签>_<二级标签>_<创意形式>_<提炼词>），这一行会叫“GOFCN1011_玩法_卖点_视频_关键词”，不是要求的“GOFCN1011_玩法_卖点_图文_关键词”：核对一级标签、二级标签、创意形式和提炼词');
  assert.equal(refused({ items: [{ quantity: 1, material_name: '玩法_卖点_图文_关键词', creative_form: '视频' }] }), '素材名称与创意形式/提炼词不一致，请澄清');
  assert.equal(refused({ quantity: 1, creative_form: '视频' }), '第 1 组缺少一级/二级标签');
  assert.equal(refused({ ...item, script_url: 'https://centurygames.feishu.cn/sheets/shtABC123?sheet=x' }), 'no error');
});

// ---- names are GOFCN<编号>_<一级>_<二级>_<创意形式>_<提炼词>; from row 23282 (2026-10-22) the production sheet's formula left out 创意形式
// and 客户端 for a while, and a new row is not to copy that

const LIVE_HEADER = ['', '创意批次', '素材编号', '提炼词', '片头引用（初版编号）', '创意引用（海外汉化解说/迭代）（初版编号）', '素材名称', '一级标签（方向）',
  '二级标签（卖点）', '创意表达（可多选）', '创意形式（制作形式）', '客户端', '设计师供应商', '创意者脚本审核人'];
const OLD = (r: number) => `CONCATENATE("GOFCN",C${r},"_",H${r},"_",I${r},"_",K${r},"_",D${r},L${r})`;
const OWN = (r: number) => `=SUBSTITUTE(CONCATENATE("GOFCN",C${r},"_",H${r},"_",I${r},"_",K${r},"_",D${r}),"__","_")`;
/** A progress sheet like the production one: the last rows named by the formula given (by default without 创意形式, as from row 23282). */
function liveSheet(last: (row: number) => string = row => `CONCATENATE("GOFCN",C${row},"_",H${row},"_",I${row},"_",D${row})`): Snapshot {
  const row = (r: number, number: number, keyword: string, tags: [string, string], formula: string, form: string | null = null) =>
    [null, null, number, keyword, null, null, { f: formula }, tags[0], tags[1], null, form, null, '达治', '靳筱萌'];
  const file = path.join(tmp(), 'live.xlsx');
  fs.writeFileSync(file, makeXlsx([{ name: '26年1月-GOFCN', rows: [LIVE_HEADER,
    row(2, 67679, '关键词', ['AI迭代', '题材片头'], OLD(2), '2D'),
    row(3, 67736, '3D_BJAI片头矿工冰层版CN60141', ['AI片头衔接', '模拟经营'], last(3)),
    row(4, 67737, '割资源冰块对抗_竖版', ['AI玩法优化', '搂冰块抢资源'], last(4)),
  ] }]));
  return new Snapshot(file);
}
/** Rows from files named 一级_二级_提炼词: no 创意形式, everything after the tags is the 提炼词 (竖版 too). */
const fromFiles = (names: string[]): { groups: Record<string, any>[] } => ({ groups: [derived({ label: 'AI玩法优化', items: names.map(name => {
  const [primary, secondary, ...rest] = name.replace(/^GOFCNx+_/, '').split('_');
  return { quantity: 1, primary_tag: primary, secondary_tag: secondary, keyword: rest.join('_'), material_name: name };
}) })] });

test('a new row is named GOFCN<编号>_<一级>_<二级>_<创意形式>_<提炼词> whatever the row above does; 创意形式 may stay empty', () => {
  const snapshot = liveSheet();
  const plan = makePlan(snapshot, { groups: [derived({ quantity: 2, primary_tag: 'AI生成', secondary_tag: '设定3.0', keyword: '企鹅保龄球' })] });
  assert.equal(plan.naming, 'GOFCN<素材编号>_<一级标签>_<二级标签>_<创意形式>_<提炼词>');
  assert.deepEqual(plan.rows.map((r: Plan) => r.name), ['GOFCN67738_AI生成_设定3.0_企鹅保龄球', 'GOFCN67739_AI生成_设定3.0_企鹅保龄球']);
  assert.deepEqual([plan.rows[0].values.K5, plan.rows[0].values.G5, plan.rows[1].values.G6], [null, OWN(5), OWN(6)]);
  const formed = makePlan(snapshot, { groups: [derived({ quantity: 1, primary_tag: 'AI生成', secondary_tag: '设定3.0', creative_form: '3D' })] });
  assert.deepEqual([formed.rows[0].values.K5, formed.rows[0].name], ['3D', 'GOFCN67738_AI生成_设定3.0_3D_关键词']);
  // A row above that names rows that way keeps its own spelling (客户端 at the end stays empty here); without a 创意形式 it gets SUBSTITUTE.
  const usual = liveSheet(OLD);
  const kept = makePlan(usual, { groups: [derived({ quantity: 1, primary_tag: 'AI生成', secondary_tag: '设定3.0', creative_form: '3D' })] });
  assert.deepEqual([kept.rows[0].values.G5, kept.rows[0].name, kept.naming], [`=${OLD(5)}`, 'GOFCN67738_AI生成_设定3.0_3D_关键词',
    'GOFCN<素材编号>_<一级标签>_<二级标签>_<创意形式>_<提炼词><客户端>']);
  const bare = makePlan(usual, { groups: [derived({ quantity: 1, primary_tag: 'AI生成', secondary_tag: '设定3.0', keyword: '冻鱼飞盘' })] });
  assert.deepEqual([bare.rows[0].values.G5, bare.rows[0].name], [`=SUBSTITUTE(${OLD(5)},"__","_")`, 'GOFCN67738_AI生成_设定3.0_冻鱼飞盘']);
  const wrapped = liveSheet(r => `SUBSTITUTE(${OLD(r)},"__","_")`);
  assert.equal(makePlan(wrapped, { groups: [derived({ quantity: 1, primary_tag: 'AI生成', secondary_tag: '设定3.0', keyword: '冻鱼飞盘' })] }).rows[0].values.G5,
    `=SUBSTITUTE(${OLD(5)},"__","_")`);
});

test('files named for rows not appended yet (GOFCNxxxxx_…) become rows of exactly those names, checked against the formula', () => {
  const snapshot = liveSheet();
  // Two versions of one piece: 兵临城下塔防 is no 创意形式 here but the start of each 提炼词.
  const names = ['GOFCNxxxxx_AI玩法优化_火车运输御敌_兵临城下塔防_冻鱼_竖版', 'GOFCNxxxxx_AI玩法优化_火车运输御敌_兵临城下塔防_企鹅_竖版'];
  const plan = makePlan(snapshot, fromFiles(names));
  assert.deepEqual(plan.rows.map((r: Plan) => [r.name, r.values[`K${r.row}`], r.values[`D${r.row}`]]), [
    ['GOFCN67738_AI玩法优化_火车运输御敌_兵临城下塔防_冻鱼_竖版', null, '兵临城下塔防_冻鱼_竖版'],
    ['GOFCN67739_AI玩法优化_火车运输御敌_兵临城下塔防_企鹅_竖版', null, '兵临城下塔防_企鹅_竖版']]);
  assert.deepEqual(plan.groups[0].request.items.map((i: Plan) => i.material_name), names.map(n => n.replace('GOFCNxxxxx_', '')));
  assert.deepEqual(plan.dropdowns.find((d: Plan) => d.field === 'secondary_tag').missing, ['火车运输御敌']);
  // Prepared again on the same sheet it is the same plan, and its CSV names the rows as the files are named.
  const prepared = prepare(plan, snapshot, { outputRoot: tmp() });
  assert.deepEqual(prepared.csv, ['创意脚本_01_AI玩法优化_火车运输御敌_供应商甲.csv']);
  assert.ok(fs.readFileSync(path.join(prepared.batch, prepared.csv[0]), 'utf8').includes('\r\nGOFCN67739_AI玩法优化_火车运输御敌_兵临城下塔防_企鹅_竖版,同上,'));
  // A file whose name does hold a 创意形式 can have it in its column: the name is the same.
  const formed = makePlan(snapshot, { groups: [derived({ items: [{ quantity: 1, primary_tag: 'AI生成', secondary_tag: '设定3.0', creative_form: '3D',
    keyword: '围炉_横版', material_name: 'GOFCNxxxxx_AI生成_设定3.0_3D_围炉_横版' }] })] });
  assert.deepEqual([formed.rows[0].name, formed.rows[0].values.K5], ['GOFCN67738_AI生成_设定3.0_3D_围炉_横版', '3D']);
  // A name the formula cannot make is refused with what the row would be called.
  const wrong = fromFiles(names);
  wrong.groups[0].items[0].keyword = '兵临城下塔防_冻鱼';
  assert.throws(() => makePlan(snapshot, wrong), (e: Error) => e instanceof Blocked && e.message
    === '按进度表的命名（GOFCN<素材编号>_<一级标签>_<二级标签>_<创意形式>_<提炼词>），这一行会叫“GOFCN67738_AI玩法优化_火车运输御敌_兵临城下塔防_冻鱼”，不是要求的“GOFCN67738_AI玩法优化_火车运输御敌_兵临城下塔防_冻鱼_竖版”：核对一级标签、二级标签、创意形式和提炼词');
  // A row of that name already in the sheet is said: the file has most likely been registered before.
  const again = makePlan(snapshot, fromFiles(['GOFCNxxxxx_AI玩法优化_搂冰块抢资源_割资源冰块对抗_竖版', ...names]));
  assert.deepEqual(sameNameRows(snapshot, again), [{ name: 'AI玩法优化_搂冰块抢资源_割资源冰块对抗_竖版',
    rows: [{ number: 67737, name: 'GOFCN67737_AI玩法优化_搂冰块抢资源_割资源冰块对抗_竖版', where: '26年1月-GOFCN 第 4 行' }] }]);
  assert.deepEqual(sameNameRows(snapshot, plan), []);
  // A name starting with a row's (cut at a _, or within the first word) may be a variant of it: said, for 合并变体名称.
  const variants = makePlan(snapshot, fromFiles(['GOFCNxxxxx_AI玩法优化_搂冰块抢资源_割资源冰块对抗_竖版_加长版', 'GOFCNxxxxx_AI玩法优化_搂冰块抢资源_割资源冰块对抗_竖版加长', ...names]));
  const row67737 = [{ number: 67737, name: 'GOFCN67737_AI玩法优化_搂冰块抢资源_割资源冰块对抗_竖版', where: '26年1月-GOFCN 第 4 行' }];
  assert.deepEqual(variantRows(snapshot, variants), [{ name: 'AI玩法优化_搂冰块抢资源_割资源冰块对抗_竖版_加长版', rows: row67737 },
    { name: 'AI玩法优化_搂冰块抢资源_割资源冰块对抗_竖版加长', rows: row67737 }]);
  assert.deepEqual(variantRows(snapshot, plan), []);
});

/** Rows registered for finished materials (the upload skill): no script link and no CLS fields, so no CSV and no ticket. */
const finished = (names: string[]): { groups: Record<string, any>[] } => {
  const { groups: [group] } = fromFiles(names);
  const { script_url, cls, label, ...rest } = group!;
  return { groups: [rest] };
};

test('rows registered for finished materials need no script link: they get no CSV and no CLS ticket, the rest of the plan is the same', () => {
  const snapshot = liveSheet();
  const names = ['GOFCNxxxxx_AI玩法优化_火车运输御敌_兵临城下塔防_冻鱼_竖版', 'GOFCNxxxxx_AI玩法优化_火车运输御敌_兵临城下塔防_企鹅_竖版'];
  const plan = makePlan(snapshot, finished(names));
  const ticketed = makePlan(snapshot, fromFiles(names));
  assert.deepEqual([plan.rows, plan.range], [ticketed.rows, ticketed.range]);
  assert.deepEqual([plan.groups[0].csv, plan.groups[0].request.script_url, plan.groups[0].request.cls], [null, '', {}]);
  assert.deepEqual(normalizeRequest(plan.request), plan.request);
  const prepared = prepare(plan, snapshot, { outputRoot: tmp() });
  assert.deepEqual(prepared.csv, []);
  assert.deepEqual(fs.readdirSync(prepared.batch).filter(f => f.endsWith('.csv')), []);
  assert.equal(report(prepared.batch).groups[0].csv, null);
  assert.throws(() => operation(prepared.batch, '01', 'save_draft', {}, {}), (e: Error) => e instanceof Blocked && e.message === NO_TICKET);
  // A ticket still needs its script link.
  const { script_url, ...unlinked } = fromFiles(names).groups[0]!;
  assert.throws(() => normalizeRequest({ groups: [unlinked] }), (e: Error) => e instanceof Blocked && e.message === '第 1 组缺少需求字段：脚本内容链接');
  assert.throws(() => normalizeRequest({ groups: [{ ...unlinked, script_url: ' ' }] }), (e: Error) => e instanceof Blocked && e.message === '缺少 script_url');
  assert.throws(() => normalizeRequest({ groups: [{ ...finished(names).groups[0], script_url: 'https://example.com/x' }] }), /脚本链接必须是当前确认的飞书文档/);
  // Finished materials were made by someone: their 设计师供应商 (the uploads' 制作人) is never left open.
  const { supplier, ...unmade } = finished(names).groups[0]!;
  for (const group of [unmade, { ...unmade, supplier: ' ' }]) {
    assert.throws(() => normalizeRequest({ groups: [group] }), (e: Error) => e instanceof Blocked && e.message === '第 1 组缺少设计师供应商：已做好的素材要写明是谁做的（也是上传的制作人）');
  }
});

test('rows for finished materials whose write landed unverified are not appended again; other files are', () => {
  const names = ['GOFCNxxxxx_AI玩法优化_火车运输御敌_兵临城下塔防_冻鱼_竖版', 'GOFCNxxxxx_AI玩法优化_火车运输御敌_兵临城下塔防_企鹅_竖版'];
  const base = tmp();
  const before = liveSheet();
  const dir = prepare(makePlan(before, finished(names)), before, { outputRoot: base }).batch as string;
  record(dir, 'append_started');
  // The sheet as it is now: the two rows went in, but the answer was lost and nothing was verified.
  const file = path.join(tmp(), 'landed.xlsx');
  const landedRow = (r: number, number: number, keyword: string) =>
    [null, null, number, keyword, null, null, { f: OWN(r).slice(1) }, 'AI玩法优化', '火车运输御敌', null, null, null, null, '张三'];
  fs.writeFileSync(file, makeXlsx([{ name: '26年1月-GOFCN', rows: [LIVE_HEADER,
    [null, null, 67679, '关键词', null, null, { f: OLD(2) }, 'AI迭代', '题材片头', null, '2D', null, '达治', '靳筱萌'],
    [null, null, 67736, '3D_BJAI片头矿工冰层版CN60141', null, null, { f: OLD(3) }, 'AI片头衔接', '模拟经营', null, null, null, '达治', '靳筱萌'],
    [null, null, 67737, '割资源冰块对抗_竖版', null, null, { f: OLD(4) }, 'AI玩法优化', '搂冰块抢资源', null, null, null, '达治', '靳筱萌'],
    landedRow(5, 67738, '兵临城下塔防_冻鱼_竖版'), landedRow(6, 67739, '兵临城下塔防_企鹅_竖版'),
  ] }]));
  const now = new Snapshot(file);
  // The same files planned again would be appended after themselves.
  const again = makePlan(now, finished(names));
  assert.equal(again.first_number, 67740);
  assert.throws(() => prepare(again, now, { outputRoot: base }), /已有一批写入发出、尚未核对/);
  // Files of other names are another batch of materials.
  const other = makePlan(now, finished(['GOFCNxxxxx_AI玩法优化_搂冰块抢资源_割资源冰块对抗_横版']));
  assert.equal(prepare(other, now, { outputRoot: base }).status, 'prepared');
});

test('a supplier who is also the 创意者脚本审核人 leaves the 设计师供应商 cell empty; the request, CLS and the message keep the person', () => {
  const snapshot = liveSheet();
  const self = { groups: [{ ...finished(['GOFCNxxxxx_AI玩法优化_火车运输御敌_兵临城下塔防_冻鱼_竖版']).groups[0], supplier: '张三' }] };
  const plan = makePlan(snapshot, self);
  assert.deepEqual([plan.rows[0].values.M5, plan.rows[0].values.N5, plan.groups[0].request.supplier], [null, '张三', '张三']);
  assert.ok(!plan.dropdowns.some((d: Plan) => d.field === 'supplier'), 'no supplier option is added for a cell left empty');
  const ticketed = makePlan(snapshot, { groups: [derived({ quantity: 1, primary_tag: 'AI生成', secondary_tag: '设定3.0', supplier: '张三' })] });
  assert.equal(ticketed.rows[0].values.M5, null);
  assert.match(composeMessage(ticketed.groups, [{ group: '01', step: 'draft_saved', evidence: {} }]).message, /\n供应商：张三\n/);
  // The column is written in one go: one group's cell empty and another's filled is two appends.
  assert.throws(() => makePlan(snapshot, { groups: [derived({ quantity: 1, primary_tag: 'AI生成', secondary_tag: '设定3.0', supplier: '张三' }),
    derived({ quantity: 1, primary_tag: 'AI生成', secondary_tag: '设定3.0', script_url: 'https://centurygames.feishu.cn/docx/Other123' })] }), /供应商就是审核人本人时那格留空/);
});

test('a requirement without a 设计师供应商 leaves its cell empty; the group message says 待定供应商', () => {
  const plan = makePlan(liveSheet(), { groups: [derived({ quantity: 1, primary_tag: 'AI生成', secondary_tag: '设定3.0', supplier: '' })] });
  assert.equal(plan.rows[0].values.M5, null);
  assert.ok(!plan.dropdowns.some((d: Plan) => d.field === 'supplier'));
  const { supplier, ...rest } = derived({ quantity: 1, primary_tag: 'AI生成', secondary_tag: '设定3.0' });
  assert.equal(normalizeRequest({ groups: [rest] }).groups[0]!.supplier, '');
  const sent = composeMessage(plan.groups, [{ group: '01', step: 'draft_saved', evidence: {} }]);
  assert.match(sent.message, /\n供应商：待定供应商\n/);
});
