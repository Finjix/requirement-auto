import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADOPTED, adopt, attachTicket, csvText, listBatches, message, NO_TICKET, prepare, record, report, status, verify } from '../src/gof/batch.ts';
import { operation, parseCsv } from '../src/gof/cls.ts';
import { makePlan } from '../src/gof/plan.ts';
import { normalizeRequest } from '../src/gof/request.ts';
import { Snapshot } from '../src/gof/snapshot.ts';
import { Blocked, digest, readJson, sha256, TARGET, writeJsonNew } from '../src/gof/util.ts';
import { main } from '../src/gof/cli.ts';
import { makeXlsx } from './helpers/xlsx-writer.ts';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const catalog = readJson(path.join(fixtures, 'catalog.json'));
const request = readJson(path.join(fixtures, 'requests', 'basic.json'));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gof-ticket-'));
const reason = (fn: () => unknown): string => {
  try { fn(); } catch (error) { assert.ok(error instanceof Blocked, (error as Error).stack); return error.message; }
  return 'no error';
};
const observations = { logged_in: true, can_create: true, unpublished: true, save_result: 'ok', required_complete: true };
const LINK = 'https://centurygames.feishu.cn/docx/ABC123def';
const ticket = { script_url: LINK, cls: { direction: '方向一', task_type: 'creative_a' } };

/** The basic request with numbers reserved only: no script link and no CLS fields (金莉's "帮我占 15 条编号"). */
function reserved() {
  const rows = structuredClone(request);
  for (const g of rows.groups) {
    delete g.cls;
    delete g.script_url;
    g.material_name = g.material_name.replace(/^GOFCN\d+_/, '');
  }
  return rows;
}

function appended(root = tmp()) {
  const base = new Snapshot(path.join(fixtures, 'base.xlsx'));
  const plan = makePlan(base, reserved());
  // The same rows as the full requirement: what is appended does not depend on the ticket.
  assert.deepEqual(plan.rows, makePlan(base, request).rows);
  const prepared = prepare(plan, base, { outputRoot: root });
  assert.deepEqual(prepared.csv, []);
  const dir = prepared.batch as string;
  return { dir, verify: () => {
    record(dir, 'append_started', null);
    record(dir, 'append_verified', null, {}, new Snapshot(path.join(fixtures, 'applied-complete.xlsx')));
  } };
}

test('a requirement without a document says 无 as its 脚本内容, in the CSV and in the CLS check', () => {
  const none = structuredClone(request);
  none.groups[0].script_url = ' 无 ';
  assert.equal(normalizeRequest(none).groups[0]!.script_url, '无');
  const base = new Snapshot(path.join(fixtures, 'base.xlsx'));
  const dir = prepare(makePlan(base, none), base, { outputRoot: tmp() }).batch as string;
  const csv = parseCsv(fs.readFileSync(path.join(dir, readJson(path.join(dir, 'manifest.json')).plan.groups[0].csv), 'utf8').slice(1));
  assert.deepEqual(csv.slice(1, 3).map(r => r[1]), ['无', '同上']);
  record(dir, 'append_started', null);
  record(dir, 'append_verified', null, {}, new Snapshot(path.join(fixtures, 'applied-complete.xlsx')));
  record(dir, 'cls_started', '01');
  assert.equal(operation(dir, '01', 'save_draft', catalog, observations).expected.link, '无');
  // Anything else still has to be a Feishu document.
  none.groups[0].script_url = '没有';
  assert.equal(reason(() => normalizeRequest(none)), '脚本链接必须是当前确认的飞书文档；没有文档时写「无」');
});

test('rows appended without a ticket get one afterwards, and then go through the CLS stage like any group', () => {
  const { dir, verify } = appended();
  assert.equal(reason(() => attachTicket(dir, '01', ticket, catalog, true)), '这一批的行还没有追加并验收，不能补需求单');
  verify();
  assert.equal(reason(() => record(dir, 'cls_started', '01')), NO_TICKET);

  // The preview is what the user approves; it writes nothing.
  const preview = attachTicket(dir, '01', ticket, catalog, true);
  const names = readJson(path.join(dir, 'manifest.json')).plan.groups[0].names as string[];
  assert.deepEqual(preview, {
    status: 'ticket_preview', group: '01', requirement_name: `${names[0]!.split('_')[0]}-${names[1]!.split('_')[0]}`, quantity: 2,
    first: names[0], last: names[1], script_url: LINK, supplier: '供应商丙', reviewer: '张三',
    cls_names: { direction: '方向一', task_type: 'creative_a', supplier: '丙公司（供应商丙）', creator: '张三' },
    native_defaults: { currency: 'cny', price: 0 }, message_kind: '玩法*2',
  });
  assert.deepEqual(fs.readdirSync(dir).filter(f => f.endsWith('.csv')), []);
  assert.deepEqual(status(dir).groups['01'], []);

  // Only the link and the CLS fields can be added; the rows stay as they were appended.
  assert.equal(reason(() => attachTicket(dir, '01', { ...ticket, supplier: '供应商甲' }, catalog)), '需求单只接受 script_url、cls、label');
  assert.equal(reason(() => attachTicket(dir, '01', { ...ticket, cls: {} }, catalog)), '缺少 CLS 字段（创意方向、任务类型）');
  assert.equal(reason(() => attachTicket(dir, '01', { cls: ticket.cls }, catalog)), '缺少脚本内容：需求文档链接，没有文档时写「无」');
  assert.equal(reason(() => attachTicket(dir, '01', { ...ticket, script_url: 'https://example.com/x' }, catalog)),
    '脚本链接必须是当前确认的飞书文档；没有文档时写「无」');
  assert.equal(reason(() => attachTicket(dir, '01', { ...ticket, cls: { direction: '方向二', task_type: 'creative_a' } }, catalog)),
    '创意方向 不存在或匹配不唯一，需在计划前澄清');

  // Attached, and corrected once more before the CLS stage: the last one counts.
  const first = attachTicket(dir, '01', { ...ticket, label: '迭代' }, catalog);
  assert.equal(first.status, 'ticket_attached');
  const second = attachTicket(dir, '01', { ...ticket, script_url: '无', label: '片头' }, catalog);
  assert.notEqual(second.csv, first.csv);
  assert.equal(fs.readFileSync(second.csv, 'utf8'), csvText(names, '无'));
  record(dir, 'cls_started', '01');
  assert.equal(reason(() => attachTicket(dir, '01', ticket, catalog)), '这一组已开始建单，需求单不能再改');

  // The CLS operations take the attached ticket: its link (here 无) and its CSV.
  const save = operation(dir, '01', 'save_draft', catalog, observations);
  assert.deepEqual([save.payload.name, save.expected.link, save.expected.names], [preview.requirement_name, '无', names]);
  const opPath = path.join(dir, 'save-operation.json');
  fs.writeFileSync(opPath, JSON.stringify(save));
  record(dir, 'cls_api_attempt', '01', { action: 'save_draft', operation_id: save.operation_id, observations });
  const parent: Record<string, any> = { id: 5001, status: -2, user_id: save.account_id, for_internal: 0, sub_scripts: [] };
  for (const [key, value] of Object.entries<any>(save.payload)) if (key !== 'asset_data') parent[key] = value === '' && key.endsWith('_date') ? null : value;
  const receipt = path.join(dir, 'save-receipt.json');
  fs.writeFileSync(receipt, JSON.stringify({ schema: 1, transport: 'cls_api', status: 'verified', unpublished: true, parent, operation_id: save.operation_id,
    action: 'save_draft', calls: [{ method: 'POST', path: '/api/workflow/script/save', http_status: 200, business_code: 0 },
      { method: 'GET', path: '/api/workflow/script/5001', http_status: 200, business_code: 0 }] }));
  record(dir, 'draft_saved', '01', { confirmed: true, unpublished: true, transport: 'cls_api', draft_id: 5001, operation: opPath, receipt,
    url: 'https://creative.centurygames.cn/requirement/5001/edit-outer' });
  const imported = operation(dir, '01', 'import_scripts', catalog, { ...observations, draft_saved: true, import_enabled: true, import_would_publish: false });
  assert.equal(Buffer.from(imported.csv.base64, 'base64').toString('utf8'), csvText(names, '无'));
  assert.equal(imported.csv.filename, path.basename(second.csv));

  // The group message and the report know the group has a ticket now, with the label it was given.
  assert.ok((message(dir).message as string).includes('（片头*2）\n供应商：供应商丙'));
  assert.equal(report(dir).groups[0].csv, second.csv);
  // The other group still has none.
  assert.deepEqual(message(dir).skipped_groups, ['02']);
});

test('a ticket is refused for a group approved with one, and a CSV changed afterwards is not taken', () => {
  const base = new Snapshot(path.join(fixtures, 'base.xlsx'));
  const full = prepare(makePlan(base, request), base, { outputRoot: tmp() }).batch as string;
  record(full, 'append_started', null);
  record(full, 'append_verified', null, {}, new Snapshot(path.join(fixtures, 'applied-complete.xlsx')));
  assert.equal(reason(() => attachTicket(full, '01', ticket, catalog, true)), '这一组获批时已带需求单，按原计划建单');

  const { dir, verify } = appended();
  verify();
  const given = { ...ticket, script_url: '无' };
  const attached = attachTicket(dir, '02', given, catalog);
  const recorded = { ...given, csv: path.basename(attached.csv), csv_sha256: sha256(fs.readFileSync(attached.csv, 'utf8')) };
  // The ticket's CSV is taken while the file is what the ticket recorded …
  assert.equal(record(dir, 'ticket_attached', '02', recorded).status, 'recorded');
  // … and no longer once it has changed: the same record is refused.
  fs.appendFileSync(attached.csv, 'x');
  assert.match(reason(() => record(dir, 'ticket_attached', '02', recorded)), /需求单的 CSV 与本组的行不符/);
});

test('the batches of the user are listed newest first, and found by a material number', async () => {
  const root = tmp();
  const { dir, verify } = appended(root);
  verify();
  attachTicket(dir, '02', ticket, catalog);
  const listed = listBatches(root);
  assert.equal(listed.batches.length, 1);
  const [only] = listed.batches;
  assert.deepEqual(only.groups.map((g: any) => [g.group, g.quantity, g.ticket, g.steps]), [['01', 2, false, []], ['02', 1, true, ['ticket_attached']]]);
  assert.equal(only.append_verified, true);
  assert.deepEqual(listBatches(root, only.first_number).batches.length, 1);
  assert.deepEqual(listBatches(root, only.last_number + 1).batches, []);
  // From the command line, and a ticket preview through it.
  const ticketFile = path.join(root, 'ticket.json');
  fs.writeFileSync(ticketFile, JSON.stringify(ticket));
  const { result, code } = await main(['batch', 'ticket', '--batch', dir, '--group', '01', '--ticket', ticketFile, '--catalog', path.join(fixtures, 'catalog.json'), '--preview']);
  assert.equal(code, 0, JSON.stringify(result));
  assert.equal(result.status, 'ticket_preview');
});

test('rows already in the sheet but in no batch are taken over as they are, and then get their ticket like reserved rows', async () => {
  const root = tmp();
  const sheet = new Snapshot(path.join(fixtures, 'applied-complete.xlsx'));
  assert.equal(reason(() => adopt(sheet, [1011, 1014], { outputRoot: root })), '进度表里没有这些编号的行：GOFCN1014');
  assert.equal(reason(() => adopt(sheet, [1011, 1012, 1013], { outputRoot: root })),
    '这些行的设计师供应商不一致（供应商丙、供应商甲）：用 --supplier 指明这张需求单的设计师供应商');
  assert.deepEqual(fs.readdirSync(root), []);

  // In any order; the sheet decides the names, the supplier and the reviewer.
  const adopted = adopt(sheet, [1012, 1011], { outputRoot: root });
  const dir = adopted.batch as string;
  assert.deepEqual(adopted, {
    status: 'rows_adopted', batch: dir, worksheet: 'GOFCN创意进度 26年3月', quantity: 2, first_number: 1011, last_number: 1012,
    first: 'GOFCN1011_玩法_卖点_视频_新爆点', last: 'GOFCN1012_玩法_卖点_视频_新爆点', supplier: '供应商丙', reviewer: '张三',
  });
  assert.equal(status(dir).append_verified, true);
  assert.equal(reason(() => adopt(sheet, [1012, 1013], { outputRoot: root })), `GOFCN1012 已在批次 ${dir} 里：用这一批继续（gof batch list --number 1012）`);

  // Nothing to append or read back.
  assert.equal(reason(() => record(dir, 'append_started', null)), ADOPTED);
  assert.equal(reason(() => verify(dir, sheet)), ADOPTED);

  // The ticket, the CLS operations and the message as for rows reserved first.
  const preview = attachTicket(dir, '01', ticket, catalog, true);
  assert.deepEqual([preview.requirement_name, preview.quantity, preview.message_kind, preview.cls_names.supplier],
    ['GOFCN1011-GOFCN1012', 2, '玩法*2', '丙公司（供应商丙）']);
  const attached = attachTicket(dir, '01', ticket, catalog);
  assert.equal(fs.readFileSync(attached.csv, 'utf8'), csvText([adopted.first, adopted.last], LINK));
  record(dir, 'cls_started', '01');
  const save = operation(dir, '01', 'save_draft', catalog, observations);
  assert.deepEqual([save.payload.name, save.expected.names], ['GOFCN1011-GOFCN1012', [adopted.first, adopted.last]]);
  record(dir, 'handoff', '01', { reason: '用户在 CLS 手动建单' });
  assert.ok((message(dir).message as string).includes('（玩法*2）\n供应商：供应商丙'));
  const [listed] = listBatches(root, 1011).batches;
  assert.deepEqual([listed.adopted, listed.groups[0].ticket], [true, true]);

  // A stop is resumed by the user's word, with nothing to read back.
  record(dir, 'blocked', null, { reason: '暂停' });
  record(dir, 'resumed', null, { confirmed: true, reason: '继续', cls_reconciled: true });
  assert.equal(status(dir).blocked, false);

  // Rows of different people: the request names who the ticket is for. From the command line.
  const other = tmp();
  const { result, code } = await main(['batch', 'adopt', '--numbers', 'GOFCN1011-GOFCN1013', '--snapshot', sheet.path, '--supplier', '供应商甲',
    '--reviewer', '李四', '--output-root', other]);
  assert.equal(code, 0, JSON.stringify(result));
  assert.deepEqual([result.quantity, result.supplier, result.reviewer], [3, '供应商甲', '李四']);
  assert.equal(attachTicket(result.batch, '01', ticket, catalog, true).message_kind, '玩法*2，画面*1');
});

test('rows of a batch only prepared can still be taken over; once its rows are verified, the batch keeps them', () => {
  const sheet = new Snapshot(path.join(fixtures, 'applied-complete.xlsx'));
  // The batch prepared for the rows is in the folder adopt looks in: it sent nothing, so it holds nothing.
  const prepared = tmp();
  appended(prepared);
  assert.equal(adopt(sheet, [1011], { outputRoot: prepared }).status, 'rows_adopted');
  const verified = tmp();
  const { verify: appendedNow } = appended(verified);
  appendedNow();
  assert.match(reason(() => adopt(sheet, [1011], { outputRoot: verified })), /^GOFCN1011 已在批次 .+ 里：用这一批继续/);
});

test('a batch whose write went out but can never be verified gives its rows to adopt once every cell it wrote is in place, and goes no further', () => {
  const root = tmp();
  const { dir } = appended(root);
  // The write went out, its verification failed (a colleague's edit moved the revision during the export), and the batch was blocked.
  record(dir, 'append_started', null);
  record(dir, 'blocked', null, { reason: '导出期间出现并发变化' });
  // Then a colleague filled in a cell the plugin leaves empty in a new row: every verification is a conflict from now on.
  const now = new Snapshot(path.join(fixtures, 'applied-occupied-optional.xlsx'));
  const verdict = verify(dir, now);
  assert.deepEqual([verdict.status, verdict.matched_cells, verdict.expected_cells], ['conflict', 24, 24]);
  // A cell it wrote that is not as written keeps the rows where they are.
  assert.match(reason(() => adopt(new Snapshot(path.join(fixtures, 'applied-bad-value.xlsx')), [1011, 1012], { outputRoot: root })),
    /^GOFCN1011 在批次 .+ 里，那一批的写入发出后没有核对通过，表里 D6 和它写的不一样/);
  assert.equal(status(dir).taken_over, undefined);
  const taken = adopt(now, [1011, 1012], { outputRoot: root });
  assert.deepEqual([taken.status, taken.taken_over, taken.first], ['rows_adopted', [dir], 'GOFCN1011_玩法_卖点_视频_新爆点']);
  // The old batch goes no further, so the rows cannot get a ticket there as well; the new batch gets theirs.
  assert.equal(status(dir).taken_over, taken.batch);
  assert.match(reason(() => record(dir, 'resumed', null, { confirmed: true, reason: '继续' }, now)), /^这一批的行已由批次 .+ 接管/);
  assert.match(reason(() => attachTicket(dir, '01', ticket, catalog, true)), /^这一批的行已由批次 .+ 接管/);
  assert.equal(attachTicket(taken.batch, '01', ticket, catalog, true).requirement_name, 'GOFCN1011-GOFCN1012');
  assert.equal(listBatches(root, 1011).batches.find((b: any) => b.batch === dir).taken_over, taken.batch);
  // Its other rows are free to be taken over as well, and appending the same rows again is still refused.
  assert.equal(adopt(now, [1013], { outputRoot: root }).status, 'rows_adopted');
  assert.throws(() => prepare(makePlan(now, reserved()), now, { outputRoot: root }), /已有一批写入发出、尚未核对/);
});

/** A batch an earlier version took over with a gap between its numbers (adopt takes one run of numbers now). */
function gappedBatch(root: string, sheet: Snapshot): string {
  const gapped = normalizeRequest({ groups: [{ supplier: '供应商甲', reviewer: '李四', items: [
    { quantity: 1, primary_tag: '玩法', secondary_tag: '卖点', creative_form: '视频', keyword: '新爆点' },
    { quantity: 1, primary_tag: '画面', secondary_tag: '体验', creative_form: '图文', keyword: '另一个' }] }] });
  const names = ['GOFCN1011_玩法_卖点_视频_新爆点', 'GOFCN1013_画面_体验_图文_另一个'];
  const sheetName = 'GOFCN创意进度 26年3月';
  const plan: Record<string, any> = { schema: 1, target: TARGET, adopted: true, worksheet: sheetName, current_sheet: null, request: gapped,
    baseline_digest: sheet.fingerprint, range: null, quantity: 2, first_number: 1011, last_number: 1013,
    rows: [{ sheet: sheetName, row: 6, number: 1011, name: names[0], group: '01' }, { sheet: sheetName, row: 8, number: 1013, name: names[1], group: '01' }],
    groups: [{ id: '01', csv: null, names, rows: [6, 8], request: gapped.groups[0] }] };
  plan.plan_id = digest(plan).slice(0, 24);
  const dir = path.join(root, plan.plan_id);
  fs.mkdirSync(path.join(dir, 'events'), { recursive: true });
  fs.copyFileSync(sheet.path, path.join(dir, 'baseline.xlsx'));
  writeJsonNew(path.join(dir, 'manifest.json'), { plan, baseline_sha256: sha256(fs.readFileSync(path.join(dir, 'baseline.xlsx'))), artifacts: {} });
  record(dir, 'rows_adopted', null, { snapshot_digest: sheet.fingerprint });
  return dir;
}

test('a batch is found by a number it holds, not by one between its first and last; a ticket is for one run of numbers', () => {
  const root = tmp();
  const sheet = new Snapshot(path.join(fixtures, 'applied-complete.xlsx'));
  const gapped = gappedBatch(root, sheet);
  assert.deepEqual(listBatches(root, 1013).batches.map((b: any) => b.batch), [gapped]);
  assert.deepEqual(listBatches(root, 1012).batches, []);
  // 1012 is in no batch: it can be taken over. A run with a gap cannot be one ticket (its name would be GOFCN1011-GOFCN1013).
  assert.equal(adopt(sheet, [1012], { outputRoot: root }).status, 'rows_adopted');
  assert.equal(reason(() => adopt(sheet, [1011, 1013], { outputRoot: tmp(), supplier: '供应商甲', reviewer: '李四' })),
    '编号要连成一段：GOFCN1011 之后是 GOFCN1013。一张需求单的名称是 GOFCN首号-GOFCN末号，不连续的编号分段各接管一次');
});

test('rows typed by hand are taken over as they are, though a new row could not be named like them', () => {
  const header = ['素材编号', '提炼词', '素材名称', '一级标签', '二级标签', '创意形式', '客户端', '设计师供应商', '创意者脚本审核人'];
  const file = path.join(tmp(), 'by-hand.xlsx');
  fs.writeFileSync(file, makeXlsx([{ name: '26年1月-GOFCN', rows: [header,
    [67679, '横版/竖版', 'GOFCN67679_玩法_卖点_2D_横版/竖版', '玩法', '卖点', '2D', null, '供应商丙', '张三'],
    [67680, '_开头', 'GOFCN67680_玩法_卖点_3D_AI__开头', '玩法', '卖点', '3D_AI', null, '供应商丙', '张三']] }]));
  const taken = adopt(new Snapshot(file), [67679, 67680], { outputRoot: tmp() });
  assert.deepEqual([taken.status, taken.first, taken.last], ['rows_adopted', 'GOFCN67679_玩法_卖点_2D_横版/竖版', 'GOFCN67680_玩法_卖点_3D_AI__开头']);
  const preview = attachTicket(taken.batch, '01', ticket, catalog, true);
  assert.deepEqual([preview.requirement_name, preview.message_kind], ['GOFCN67679-GOFCN67680', '玩法*2']);
  const attached = attachTicket(taken.batch, '01', ticket, catalog);
  assert.equal(fs.readFileSync(attached.csv, 'utf8'), csvText([taken.first, taken.last], LINK));
  // A new row still has to be one a name can be made of.
  assert.throws(() => normalizeRequest({ groups: [{ supplier: '供应商丙', reviewer: '张三', primary_tag: '玩法', secondary_tag: '卖点', quantity: 1, keyword: '横版/竖版' }] }),
    /不能含 \/ 或/);
});
