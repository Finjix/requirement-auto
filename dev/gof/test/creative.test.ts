import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildUploadPlan, creativeName, findDirectory, formulaText, loadUploadPlan, materialNumber, materialRefusal, normalizeUploadRequest, parseNumbers,
  lookupRows, matchPeople, nameParts, pendingBody, progressRowsFrom, scanMaterials, searchProgressRows, uploadEvents, uploadPlanSummary, hashFile, variantBases, type UploadOptions,
} from '../src/gof/creative.ts';
import { unpackZip } from '../src/gof/unzip.ts';
import { createCreativeAdapter } from '../src/gof/creative-adapter.ts';
import { findRows, listFiles, planUpload, runUpload, uploadOptions, uploadStatus, type UploadDeps } from '../src/gof/creative-online.ts';
import type { Online } from '../src/gof/cls-online.ts';
import type { Bridge } from '../src/gof/feishu.ts';
import { Snapshot } from '../src/gof/snapshot.ts';
import { Blocked, NODE } from '../src/gof/util.ts';
import { ACCOUNT, DIRS, fakeCreative, GAME, PEOPLE, TYPES, type FakeCreative } from './helpers/fake-creative.ts';
import { tempDir } from './helpers/tmp.ts';
import { makeXlsx } from './helpers/xlsx-writer.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const OPTIONS: UploadOptions = { account: ACCOUNT, game: { id: GAME.id, code: GAME.code, name: GAME.name }, can_upload: true, directories: DIRS, creators: PEOPLE.creative_users, producers: PEOPLE.producers, types: TYPES };

function materials(files: Record<string, string>): string {
  const dir = tempDir('materials-');
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

async function hashed(inputs: string[]) {
  const { materials: found, skipped } = scanMaterials(inputs);
  const out = [];
  for (const m of found) out.push({ ...m, ...(await hashFile(m.file)) });
  return { materials: out, skipped };
}

const online = (fake: FakeCreative, account = ACCOUNT): Online => ({
  session: async () => ({ authorization: 'Bearer good', account, origin: fake.origin }),
  capture: async () => ({ state: 'login_required' }),
});
const depsFor = (): UploadDeps => ({ adapter: { uploadHost: /^127\.0\.0\.1$/, allowHttpUpload: true }, batchRoot: tempDir('upload-batches-'), tmpDir: tempDir('upload-tmp-'), sleep: async () => undefined, reconcileTries: 1 });

/** A plan the user approved. These tests are about the run, so the files keep their names unless the request asks for the progress sheet. */
async function approvedPlan(fake: FakeCreative, deps: UploadDeps, request: Record<string, unknown>, bridge?: Bridge): Promise<string> {
  const dir = tempDir('upload-plan-');
  fs.writeFileSync(path.join(dir, 'request.json'), JSON.stringify({ progress: false, ...request }));
  const summary = await planUpload(online(fake), bridge, path.join(dir, 'request.json'), path.join(dir, 'plan.json'), deps);
  assert.equal(summary.status, 'upload_plan');
  return summary.plan;
}

/**
 * The progress sheet of the 终稿库 example (玩法AI迭代素材.zip): the two originals the new pieces build on, the four rows the
 * requirement appended for them (围炉煮冰 twice: the V90 and its 国风配乐 version), and a row named by SUBSTITUTE as some newer rows are.
 */
const HEADER = ['', '创意批次', '素材编号', '提炼词', '片头引用（初版编号）', '创意引用（海外汉化解说/迭代）（初版编号）', '素材名称', '一级标签（方向）',
  '二级标签（卖点）', '创意表达（可多选）', '创意形式（制作形式）', '客户端', '设计师供应商', '创意者脚本审核人'];
function progressRow(row: number, number: number, keyword: string, tags: [string, string, string], people: [string, string], substitute = false) {
  const inner = `CONCATENATE("GOFCN",C${row},"_",H${row},"_",I${row},"_",K${row},"_",D${row},L${row})`;
  return [null, null, number, keyword, null, null, { f: substitute ? `SUBSTITUTE(${inner},"__","_")` : inner }, tags[0], tags[1], null, tags[2] || null, null, people[0], people[1]];
}
function finalCutSheet(): string {
  const file = path.join(tempDir('progress-'), 'progress.xlsx');
  fs.writeFileSync(file, makeXlsx([{ name: '26年1月-GOFCN', rows: [HEADER,
    progressRow(2, 56890, '火车运输御敌-斜', ['汉化', '竞争对抗', '3D'], ['廿十一', '金莉']),
    progressRow(3, 44065, '转斧杀熊烤肉', ['汉化', '资源城建', '3D'], ['廿十一', '金莉']),
    progressRow(4, 67680, '企鹅保龄球', ['AI生成', '设定3.0', '3D'], ['廿十一', '金莉']),
    progressRow(5, 67681, '冻鱼飞盘', ['AI生成', '设定3.0', '3D'], ['廿十一', '金莉']),
    progressRow(6, 67682, '围炉煮冰', ['AI生成', '设定3.0', '3D'], ['廿十一', '金莉']),
    progressRow(7, 67683, '围炉煮冰', ['AI生成', '设定3.0', '3D'], ['廿十一', '金莉']),
    progressRow(8, 67684, '关键词', ['AI生成', '设定3.0', ''], ['菲比', '钱程'], true),
  ] }]));
  return file;
}
/** Feishu as far as the progress lookup goes: the plugin's sheet node, exported as the given workbook. */
const sheetBridge = (xlsx: string, exports: string[] = []): Bridge => ({
  doctor: async () => ({ status: 'ok' }),
  apiRead: async () => ({ node: { node_token: NODE, obj_type: 'sheet', obj_token: 'shtTEST' } }),
  exportSheet: async (_token: string, output: string) => { exports.push(output); fs.copyFileSync(xlsx, output); return { status: 'exported' }; },
}) as unknown as Bridge;
/** The four videos of 玩法AI迭代素材.zip, under their names there, and which row each is according to the 终稿库 document. */
const FINAL_CUT_FILES = { 'g44065_gf_v90.mp4': 'guofeng', 'g44065_v90.mp4': 'cartoon', 'g56890_a_v15.mp4': 'penguin', 'g56890_c_v21.mp4': 'fish' };
const FINAL_CUT_ITEMS = [{ file: 'g56890_a_v15.mp4', number: 67680 }, { file: 'g56890_c_v21.mp4', number: 67681 },
  { file: 'g44065_v90.mp4', number: 67682 }, { file: 'g44065_gf_v90.mp4', number: 'GOFCN67683' }];

const writes = (fake: FakeCreative, suffix: string) => fake.requests.filter(r => r.method === 'POST' && r.path.endsWith(suffix)).length;

test('one file is one creative named like the file; folders are read one level deep; what cannot go up is said with the reason', () => {
  const dir = materials({ 'GOFCN66367_片头_竖版.mp4': 'v', '封面.PNG': 'p', 'notes.txt': 't', 'pack.zip': 'z', '.hidden.mp4': 'h', 'empty.mp4': '', 'sub/inner.mp4': 'i' });
  const { materials: found, skipped } = scanMaterials([dir]);
  assert.deepEqual(found.map(m => [m.name, m.kind, m.number]).sort(), [['GOFCN66367_片头_竖版', 'video', 66367], ['封面', 'image', null]]);
  const reasons = Object.fromEntries(skipped.map(s => [path.basename(s.file), s.reason]));
  assert.match(reasons['notes.txt']!, /不支持这种格式/);
  assert.match(reasons['pack.zip']!, /压缩包/);
  assert.equal(reasons['.hidden.mp4'], '隐藏文件');
  assert.equal(reasons['empty.mp4'], '空文件');
  assert.match(reasons.sub!, /不可嵌套/);
  assert.equal(creativeName('a‪b‬c.mp4'), 'abc', 'the marks the page strips are stripped');
  assert.equal(materialNumber('GOFCNIM14462_图片'), null, 'another numbering series is no material number');
  assert.equal(materialNumber('GOFCN20261019002_需求'), null, 'a requirement number is no material number');
  assert.equal(materialNumber('x_GOFCN67471_AI剧情'), 67471);
});

test('the request takes only the known fields, each in its form', () => {
  assert.throws(() => normalizeUploadRequest({ files: ['a.mp4'], tags: [] }), /未知字段：tags/);
  assert.throws(() => normalizeUploadRequest({ files: [] }), /files/);
  assert.throws(() => normalizeUploadRequest({ files: ['a.mp4'], producers: '丁杰' }), /producers/);
  assert.throws(() => normalizeUploadRequest({ files: ['a.mp4'], items: [{ file: 'a.mp4', creater: 'x' }] }), /未知字段：creater/);
  assert.deepEqual(normalizeUploadRequest({ files: ['a.mp4'], progress: false }), { files: ['a.mp4'], progress: false });
  assert.deepEqual(normalizeUploadRequest({ files: ['a.mp4'] }), { files: ['a.mp4'], progress: true }, 'the progress sheet is read unless the request says not to');
  assert.deepEqual(normalizeUploadRequest({ files: ['a.mp4'], items: [{ file: 'a.mp4', number: 'GOFCN67680' }, { file: 'b.mp4', number: 67681 }] }).items!.map(i => i.number), [67680, 67681]);
  assert.throws(() => normalizeUploadRequest({ files: ['a.mp4'], items: [{ file: 'a.mp4', number: 'GOFCN20261022001' }] }), /GOFCN 素材编号/);
  for (const bad of [20261022001, 67680.5, 0, -3, '企鹅保龄球']) assert.throws(() => normalizeUploadRequest({ files: ['a.mp4'], items: [{ file: 'a.mp4', number: bad }] }), /GOFCN 素材编号/);
  assert.equal(normalizeUploadRequest({ files: ['a.mp4'], items: [{ file: 'a.mp4', number: 1001, name: '新名称' }] }).items![0]!.name, '新名称', 'checked against its row in the plan');
  assert.equal(normalizeUploadRequest({ files: ['a.mp4'], items: [{ file: 'a.mp4', number: 1001, sheet: '26年3月-GOFCN' }] }).items![0]!.sheet, '26年3月-GOFCN');
  assert.equal(normalizeUploadRequest({ files: ['a.mp4'], progress: false, items: [{ file: 'a.mp4', name: '新名称' }] }).items![0]!.name, '新名称');
  assert.throws(() => normalizeUploadRequest({ files: ['a.mp4'], progress: false, items: [{ file: 'a.mp4', number: 67680 }] }), /只在按进度表上传时有用/);
});

test('material numbers on the command line: single, ranges as CLS names them, with or without GOFCN', () => {
  assert.deepEqual(parseNumbers('67680-67683,67690'), [67680, 67681, 67682, 67683, 67690]);
  assert.deepEqual(parseNumbers('GOFCN67680-GOFCN67682 GOFCN67680'), [67680, 67681, 67682]);
  assert.deepEqual(parseNumbers('67682、67680'), [67682, 67680]);
  assert.throws(() => parseNumbers('67683-67680'), /范围不对/);
  assert.throws(() => parseNumbers('1-1000'), /范围不对/);
  assert.throws(() => parseNumbers('企鹅'), /看不懂的编号/);
});

test('naming formulas read as the sheet shows them: CONCATENATE with empty arguments, SUBSTITUTE around it, a cell of another row', () => {
  const cells: Record<string, string | null> = { C9: '67651', H9: 'AI生成', I9: '设定3.0', K9: '', D9: '关键词', L9: '', F8: 'GOFCN23972', G7: null };
  const at = (coord: string) => (coord in cells ? cells[coord]! : '');
  assert.equal(formulaText('=CONCATENATE("GOFCN",C9,"_",H9,"_",I9,"_",K9,"_",D9,L9)', at), 'GOFCN67651_AI生成_设定3.0__关键词');
  assert.equal(formulaText('=SUBSTITUTE(CONCATENATE("GOFCN",C9,"_",H9,"_",I9,"_",K9,"_",D9,L9),"__","_")', at), 'GOFCN67651_AI生成_设定3.0_关键词');
  assert.equal(formulaText('=CONCATENATE("GOFCN",$C$9,"_",H9,"_",D9,,L9)', at), 'GOFCN67651_AI生成_关键词', 'an empty argument is an empty text');
  assert.equal(formulaText('=concat("GOFCN",C9,"_迭代_",F8)', at), 'GOFCN67651_迭代_GOFCN23972', 'another row is just another cell');
  assert.equal(formulaText('=CONCATENATE("say ""hi""",1)', at), 'say "hi"1');
  assert.equal(formulaText('=CONCATENATE("GOFCN",G7)', at), null, 'a cell that is itself a formula is not followed');
  assert.equal(formulaText('=CONCATENATE("GOFCN",C9,"_",A1:0)', at), null, 'a range is no text');
  assert.equal(formulaText('=TRIM(CONCATENATE("GOFCN",C9))', at), null, 'other functions are not guessed');
  assert.equal(formulaText('=CONCATENATE("GOFCN",C9', at), null);
  assert.equal(formulaText('GOFCN67651', at), null);
});

test('an upload directory is found by its name, a path ending or its ID, and only when that is unique', () => {
  assert.deepEqual(findDirectory(DIRS, '双端共用-视频'), { id: 1585089, path: '无尽冬日 - NEW / 常规素材 / 双端共用-视频' });
  assert.equal(findDirectory(DIRS, '常规素材/图片').id, 1573621);
  assert.equal(findDirectory(DIRS, '1585181').id, 1585181);
  assert.throws(() => findDirectory(DIRS, '图片'), /不唯一/);
  assert.throws(() => findDirectory(DIRS, '不存在的目录'), /没有上传目录/);
});

test('the plan: the default directory, 素材类型 by file kind, short names matched to CLS people, a file setting over the request', async () => {
  const dir = materials({ 'a.mp4': 'video-a', 'b.jpg': 'image-b', 'c.mp3': 'audio-c' });
  const { materials: found, skipped } = await hashed([dir]);
  const request = normalizeUploadRequest({ files: [dir], progress: false, creator: '张天伟', producers: ['丁杰'], items: [{ file: 'b.jpg', creator: '雷佳威', producers: ['杨燃', '谢振文'], directory: '常规素材/图片' }] });
  const plan = buildUploadPlan({ request, options: OPTIONS, materials: found, skipped, existing: new Set() });
  const by = Object.fromEntries(plan.items.map((i: any) => [i.name, i]));
  assert.equal(by.a.type.name, '视频');
  assert.equal(by.b.type.name, '图片');
  assert.equal(by.c.type.name, '其他');
  assert.equal(by.a.directory.id, 1585089);
  assert.equal(by.b.directory.id, 1573621);
  assert.deepEqual(by.a.producers, [{ id: 663, name: '北京柒曦文化传媒有限公司（丁杰）' }]);
  assert.deepEqual(by.b.producers.map((p: any) => p.id), [1163, 1405]);
  assert.equal(by.b.creator.name, '雷佳威');
  assert.equal(by.a.source.creator, 'request');
  assert.equal(by.b.source.creator, 'item');
  const summary = uploadPlanSummary(plan, 'plan.json');
  assert.deepEqual(summary.types, { 视频: 1, 图片: 1, 其他: 1 });
});

test('the people of files not registered yet are matched to CLS before any plan: each name to its CLS name, or what is wrong with it', async () => {
  assert.deepEqual(matchPeople(OPTIONS, { creator: '金莉', producers: ['丁杰', '廿十一'] }), {
    creator: { wanted: '金莉', id: 2001, name: '金莉' },
    producers: [{ wanted: '丁杰', id: 663, name: '北京柒曦文化传媒有限公司（丁杰）' }, { wanted: '廿十一', problem: '制作人“廿十一” 不存在或匹配不唯一，需在计划前澄清' }],
  });
  assert.deepEqual(matchPeople(OPTIONS, { creator: '李晨阳' }), { creator: { wanted: '李晨阳', problem: '创意人“李晨阳” 不存在或匹配不唯一，需在计划前澄清' } });
  assert.deepEqual(matchPeople(OPTIONS, { creator: '492', producers: ['长沙廿拾一文化传媒有限公司'] }),
    { creator: { wanted: '492', id: 492, name: '李晨阳' }, producers: [{ wanted: '长沙廿拾一文化传媒有限公司', id: 2002, name: '长沙廿拾一文化传媒有限公司' }] });
  assert.deepEqual(matchPeople(OPTIONS, {}), {});
  // gof creative options --creator 金莉 --producers 廿十一: the same, from what CLS offers this account.
  const fake = await fakeCreative();
  try {
    const offered = await uploadOptions(online(fake), { creator: '金莉', producers: ['廿十一'] }, depsFor());
    assert.deepEqual(offered.people, { creator: { wanted: '金莉', id: 2001, name: '金莉' },
      producers: [{ wanted: '廿十一', problem: '制作人“廿十一” 不存在或匹配不唯一，需在计划前澄清' }] });
    assert.equal((await uploadOptions(online(fake), {}, depsFor())).people, undefined);
  } finally { fake.close(); }
});

test('the plan says everything that is not settled, at once: no 创意人, ambiguous people, a taken or doubled name', async () => {
  const dir = materials({ 'a.mp4': '1', 'x.mp4': '2', 'x.png': '3' });
  const { materials: found, skipped } = await hashed([dir]);
  const build = (request: Record<string, unknown>, existing = new Set<string>()) =>
    buildUploadPlan({ request: normalizeUploadRequest({ files: [dir], progress: false, ...request }), options: OPTIONS, materials: found, skipped, existing });
  assert.throws(() => build({ producers: ['丁杰'] }), (error: Error) => error instanceof Blocked && /创意人未定/.test(error.message) && /同一个创意名称“x”/.test(error.message));
  assert.throws(() => build({ creator: '李晨阳', producers: ['丁杰'], items: [{ file: 'x.png', skip: true }] }), /李晨阳.*不唯一/);
  const byId = build({ creator: '492', producers: ['丁杰'], items: [{ file: 'x.png', skip: true }] });
  assert.ok(byId.items.every((i: any) => i.creator.id === 492), 'a CLS user ID picks one of two people with the same name');
  assert.ok(byId.skipped.some((s: any) => s.reason === '按要求不上传'));
  assert.throws(() => build({ creator: '张天伟', producers: ['丁杰'], items: [{ file: 'x.png', skip: true }] }, new Set(["a"])), /CLS 已有同名创意.*：a$/);
  const renamed = build({ creator: '张天伟', producers: ['丁杰'], items: [{ file: 'x.png', name: 'x_封面' }] });
  assert.deepEqual(renamed.items.map((i: any) => i.name).sort(), ['a', 'x', 'x_封面']);
  const cover = renamed.items.find((i: any) => i.name === 'x_封面');
  assert.deepEqual([cover.renamed_from, cover.upload_name], ['x', 'x_封面.png'], 'a renamed file goes up under the new name too');
  assert.equal(renamed.items.find((i: any) => i.name === 'a').upload_name, undefined);
});

test('the progress sheet gives the name (素材名称), 创意人 (创意者脚本审核人) and 制作人 (设计师供应商) by material number; a missing or doubled number is asked', async () => {
  const snapshot = new Snapshot(path.join(here, 'fixtures', 'base.xlsx'));
  const rows = progressRowsFrom(snapshot, [1001, 1002, 1004, 9999]);
  assert.equal(rows.get(1001)!.length, 2, 'a number on two rows is two rows');
  assert.equal(rows.get(1004)!.length, 1);
  const { sheet, row, number, supplier, reviewer } = rows.get(1004)![0]!;
  assert.deepEqual({ sheet, row, number, supplier, reviewer }, { sheet: 'GOFCN创意进度 26年3月', row: 2, number: 1004, supplier: '供应商甲', reviewer: '张三' });
  assert.match(rows.get(1004)![0]!.name!, /^GOFCN1004_/, 'the name comes out of the naming formula');
  assert.equal(rows.get(1002)![0]!.name, 'GOFCN1002_玩法_卖点_视频_爆点B');
  assert.equal(rows.has(9999), false);

  const people = { ...OPTIONS, creators: [...OPTIONS.creators, { id: 9001, name: '张三' }], producers: [...OPTIONS.producers, { id: 9002, name: '某某公司（供应商甲）' }] };
  const dir = materials({ 'GOFCN1004_成片.mp4': 'a' });
  const { materials: found, skipped } = await hashed([dir]);
  const request = (items?: unknown[]) => normalizeUploadRequest({ files: [dir], progress: true, ...(items ? { items } : {}) });
  assert.throws(() => buildUploadPlan({ request: request(), options: people, materials: found, skipped, existing: new Set(), progress: rows }),
    /文件名里的 GOFCN1004 那一行的素材名称是.*和文件名不同.*用 items\[\]\.number 写明/, 'a file not named as its row is never placed by the number in its name');
  const plan = buildUploadPlan({ request: request([{ file: 'GOFCN1004_成片.mp4', number: 1004 }]), options: people, materials: found, skipped, existing: new Set(), progress: rows });
  assert.equal(plan.items[0].creator.name, '张三');
  assert.deepEqual(plan.items[0].producers, [{ id: 9002, name: '某某公司（供应商甲）' }]);
  assert.equal(plan.items[0].source.progress_row.row, 2);
  assert.equal(plan.items[0].source.progress_row.by, 'item');
  assert.equal(plan.items[0].name, rows.get(1004)![0]!.name, 'a file named otherwise goes up as its row is named');
  assert.deepEqual([plan.items[0].renamed_from, plan.items[0].upload_name], ['GOFCN1004_成片', `${rows.get(1004)![0]!.name}.mp4`]);

  for (const [file, items, pattern] of [['GOFCN1001_x.mp4', [{ file: 'GOFCN1001_x.mp4', number: 1001 }], /有 2 行，内容不同.*同一个分表里重号/],
    ['GOFCN9999_x.mp4', undefined, /进度表里没有 GOFCN9999（编号取自文件名）/], ['无编号.mp4', undefined, /也不带 GOFCN 编号/]] as const) {
    const other = materials({ [file]: 'b' });
    const scanned = await hashed([other]);
    assert.throws(() => buildUploadPlan({ request: normalizeUploadRequest({ files: [other], progress: true, ...(items ? { items } : {}) }), options: people, ...scanned, existing: new Set(), progress: rows }), pattern);
  }
});

test('an approved plan cannot be edited by hand', async () => {
  const fake = await fakeCreative();
  try {
    const deps = depsFor();
    const file = await approvedPlan(fake, deps, { files: [materials({ 'a.mp4': 'x' })], creator: '张天伟', producers: ['丁杰'] });
    const plan = JSON.parse(fs.readFileSync(file, 'utf8'));
    plan.items[0].creator = { id: 1104, name: '雷佳威' };
    fs.writeFileSync(file, JSON.stringify(plan));
    assert.throws(() => loadUploadPlan(file), /摘要不匹配/);
  } finally { fake.close(); }
});

test('a run does what the page does: sign, put each file without CLS credentials, create once, annotate, read back', async () => {
  const fake = await fakeCreative();
  try {
    const deps = depsFor();
    const dir = materials({ 'GOFCN66367_片头.mp4': 'video bytes', '封面.png': 'png bytes' });
    const file = await approvedPlan(fake, deps, { files: [dir], creator: '张天伟', producers: ['丁杰'] });
    const result = await runUpload(online(fake), file, deps);
    assert.equal(result.status, 'uploaded', JSON.stringify(result));
    assert.equal(result.uploaded.length, 2);
    assert.ok(result.uploaded.every((u: any) => u.verified && u.creator === '张天伟' && u.producers[0] === '北京柒曦文化传媒有限公司（丁杰）'));
    const order = fake.requests.filter(r => r.method !== 'GET').map(r => `${r.method} ${r.path.startsWith('/cos/') ? '/cos' : r.path}`);
    assert.deepEqual(order, ['POST /api/qcloud/signed-url', 'POST /api/report/log', 'PUT /cos', 'PUT /cos', 'POST /api/report/log', 'POST /api/creative/multiple-upload', 'POST /api/creative/multiple-edit']);
    const create = fake.requests.find(r => r.path === '/api/creative/multiple-upload')!;
    assert.equal(create.query, '?confirmed=1');
    assert.deepEqual(create.body!.adsdesk_dir_ids, { 'GOFCN66367_片头': 1585089, 封面: 1585089 });
    const edit = fake.requests.find(r => r.path === '/api/creative/multiple-edit')!;
    assert.deepEqual(edit.body!.creatives.map((c: any) => [c.sponsor, c.producers, c.types, c.custom_tags]).sort(), [[653, [663], ['image'], []], [653, [663], ['video'], []]]);
    assert.ok(fake.requests.filter(r => r.method === 'PUT').every(r => r.authorization === undefined), 'storage never sees the CLS login');
    assert.ok([...fake.objects.values()].every(o => o.contentType === 'application/x-www-form-urlencoded'), 'the Content-Type the page sends');
    assert.ok(fake.logs.every(l => l.includes('requirement-auto')), 'the CLS log says the upload came from the plugin');
    // No upload link (with its signature) is ever written down.
    const batchFiles = fs.readdirSync(result.batch, { recursive: true }).map(String).filter(f => f.endsWith('.json'));
    for (const name of batchFiles) assert.doesNotMatch(fs.readFileSync(path.join(result.batch, name), 'utf8'), /sign=|q-signature|Bearer/);
    // Running the finished plan again only reads.
    const before = fake.requests.filter(r => r.method !== 'GET').length;
    const again = await runUpload(online(fake), file, deps);
    assert.equal(again.status, 'uploaded');
    assert.equal(fake.requests.filter(r => r.method !== 'GET').length, before);
    assert.equal(uploadStatus(file, deps).create_sent, true);
  } finally { fake.close(); }
});

test('a create whose answer is lost is found by reading back, and never sent again', async () => {
  const fake = await fakeCreative();
  try {
    const deps = depsFor();
    fake.createMode = 'lose-answer';
    const file = await approvedPlan(fake, deps, { files: [materials({ 'a.mp4': 'aa', 'b.mp4': 'bb' })], creator: '张天伟', producers: ['丁杰'] });
    const result = await runUpload(online(fake), file, deps);
    assert.equal(result.status, 'uploaded', JSON.stringify(result));
    assert.equal(writes(fake, 'multiple-upload'), 1);
    const steps = uploadEvents(result.batch).map(e => e.step);
    assert.ok(steps.includes('create_unknown') && steps.includes('reconciled'));
    fake.createMode = 'normal';
    await runUpload(online(fake), file, deps);
    assert.equal(writes(fake, 'multiple-upload'), 1, 'not even on a later run');
  } finally { fake.close(); }
});

test('a create that did not happen is reported as not found yet, and a later run still does not create', async () => {
  const fake = await fakeCreative();
  try {
    const deps = depsFor();
    fake.createMode = 'hang-up';
    const file = await approvedPlan(fake, deps, { files: [materials({ 'a.mp4': 'aa' })], creator: '张天伟', producers: ['丁杰'] });
    const result = await runUpload(online(fake), file, deps);
    assert.equal(result.status, 'unknown');
    assert.deepEqual(result.missing.map((m: any) => m.name), ['a']);
    fake.createMode = 'normal';
    const again = await runUpload(online(fake), file, deps);
    assert.equal(again.status, 'unknown');
    assert.equal(writes(fake, 'multiple-upload'), 1);
    assert.equal(fake.creatives.size, 0);
  } finally { fake.close(); }
});

test('a creative of the same name made by hand after a lost create is not taken for this batch\'s, and is left as it is', async () => {
  const fake = await fakeCreative();
  try {
    const deps = depsFor();
    fake.createMode = 'hang-up';
    const file = await approvedPlan(fake, deps, { files: [materials({ 'a.mp4': 'aa' })], creator: '张天伟', producers: ['丁杰'] });
    assert.equal((await runUpload(online(fake), file, deps)).status, 'unknown');
    // Meanwhile the user uploads something called "a" on the page, with other people and a tag.
    const byHand = { id: 99, name: 'a', upload_user_id: ACCOUNT.id, user_id: 1104, user_ids: [1104], producers: [1405], types: ['aigc'], custom_tags: ['手动标签'],
      confirmed: true, materials: [{ id: 990, name: 'a', file_hash: 'f'.repeat(32) }] };
    fake.creatives.set(99, structuredClone(byHand));
    fake.createMode = 'normal';
    const again = await runUpload(online(fake), file, deps);
    assert.equal(again.status, 'unknown');
    assert.deepEqual(again.missing.map((m: any) => m.name), ['a']);
    assert.deepEqual(fake.creatives.get(99), byHand, 'not annotated');
    assert.equal(writes(fake, 'multiple-edit'), 0);
  } finally { fake.close(); }
});

test('a file CLS already has (same MD5) is reported, the rest go up', async () => {
  const fake = await fakeCreative();
  try {
    const deps = depsFor();
    const dir = materials({ 'new.mp4': 'fresh', 'copy.mp4': 'dup' });
    fake.creatives.set(1, { id: 1, name: 'old', upload_user_id: 653, user_id: 653, user_ids: [653], confirmed: true, materials: [{ file_hash: (await hashFile(path.join(dir, 'copy.mp4'))).md5 }] });
    const file = await approvedPlan(fake, deps, { files: [dir], creator: '张天伟', producers: ['丁杰'] });
    const result = await runUpload(online(fake), file, deps);
    assert.equal(result.status, 'partial');
    assert.deepEqual(result.uploaded.map((u: any) => u.name), ['new']);
    assert.deepEqual(result.not_created.map((d: any) => d.name), ['copy']);
    assert.match(result.not_created[0].reason, /MD5/);
  } finally { fake.close(); }
});

test('a refused create is looked up once: nothing made is blocked, what was made anyway is annotated and the rest reported', async () => {
  for (const [mode, expected] of [['refuse', 'blocked'], ['refuse-after-first', 'partial']] as const) {
    const fake = await fakeCreative();
    try {
      const deps = depsFor();
      fake.createMode = mode;
      const file = await approvedPlan(fake, deps, { files: [materials({ 'a.mp4': 'aa', 'b.mp4': 'bb' })], creator: '张天伟', producers: ['丁杰'] });
      const result = await runUpload(online(fake), file, deps);
      assert.equal(result.status, expected, JSON.stringify(result));
      if (expected === 'blocked') {
        assert.match(result.reason, /业务码 403，素材处理失败/);
        assert.equal(writes(fake, 'multiple-edit'), 0);
      } else {
        assert.deepEqual(result.uploaded.map((u: any) => [u.name, u.verified]), [['a', true]]);
        assert.deepEqual(result.not_created.map((n: any) => n.name), ['b']);
        assert.match(result.not_created[0].reason, /拒绝创建/);
      }
      fake.createMode = 'normal';
      await runUpload(online(fake), file, deps);
      assert.equal(writes(fake, 'multiple-upload'), 1, 'a refused create is not sent again either');
    } finally { fake.close(); }
  }
});

test('an annotation that did not take is sent again after the read-back; a refused one is reported', async () => {
  const fake = await fakeCreative();
  try {
    const deps = depsFor();
    fake.annotateMode = 'ignore-once';
    const file = await approvedPlan(fake, deps, { files: [materials({ 'a.mp4': 'aa' })], creator: '张天伟', producers: ['丁杰'] });
    const result = await runUpload(online(fake), file, deps);
    assert.equal(result.status, 'uploaded');
    assert.equal(writes(fake, 'multiple-edit'), 2);

    const other = await fakeCreative();
    try {
      other.annotateMode = 'refuse';
      const deps2 = depsFor();
      const file2 = await approvedPlan(other, deps2, { files: [materials({ 'b.mp4': 'bb' })], creator: '张天伟', producers: ['丁杰'] });
      const refused = await runUpload(online(other), file2, deps2);
      assert.equal(refused.status, 'partial');
      assert.match(refused.annotate_error, /没有编辑权限/);
      assert.equal(writes(other, 'multiple-edit'), 1);
      assert.deepEqual(refused.uploaded[0].problems, ['创意人', '制作人', '素材类型']);
    } finally { other.close(); }
  } finally { fake.close(); }
});

test('nothing is sent when a file changed after approval, a name got taken, or another account is logged in', async () => {
  const fake = await fakeCreative();
  try {
    const deps = depsFor();
    const dir = materials({ 'a.mp4': 'approved' });
    const file = await approvedPlan(fake, deps, { files: [dir], creator: '张天伟', producers: ['丁杰'] });
    fs.writeFileSync(path.join(dir, 'a.mp4'), 'replaced!');
    await assert.rejects(runUpload(online(fake), file, deps), /批准后/);
    fs.writeFileSync(path.join(dir, 'a.mp4'), 'approved');
    fake.creatives.set(7, { id: 7, name: 'a', upload_user_id: 653, confirmed: true, materials: [] });
    await assert.rejects(runUpload(online(fake), file, deps), /同名创意：a/);
    fake.creatives.delete(7);
    await assert.rejects(runUpload(online(fake, { id: 2, name: '别人' }), file, deps), /不是计划里的/);
    assert.equal(fake.requests.filter(r => r.method !== 'GET').length, 0);
  } finally { fake.close(); }
});

test('the client: no delete or other path, puts only to links CLS gave, and refuses links that do not lead to object storage', async () => {
  const fake = await fakeCreative();
  try {
    const api = createCreativeAdapter({ origin: fake.origin, authorization: 'Bearer good', uploadHost: /^127\.0\.0\.1$/, allowHttpUpload: true });
    await assert.rejects(api.put('a/a.mp4', fileURLToPath(import.meta.url), 1), /没有这个文件的上传链接/);
    fake.signElsewhere = true;
    await assert.rejects(api.sign(94, ['a/a.mp4']), /不是对象存储（evil\.example\.com）/);
    assert.ok(!('delete' in api) && !('publish' in api) && !('confirm' in api));
    const production = createCreativeAdapter({ origin: fake.origin, authorization: 'Bearer good' });
    fake.signElsewhere = false;
    await assert.rejects(production.sign(94, ['a/a.mp4']), /不是对象存储/, 'production only puts to Tencent COS over https');
  } finally { fake.close(); }
});

test('an account without the upload permission gets no plan', async () => {
  const fake = await fakeCreative({ canUpload: false });
  try {
    await assert.rejects(approvedPlan(fake, depsFor(), { files: [materials({ 'a.mp4': 'x' })], creator: '张天伟', producers: ['丁杰'] }), /没有上传创意的权限/);
  } finally { fake.close(); }
});

test('a zipped folder (how a folder reaches lark-agent) is planned and uploaded by the files inside it', async () => {
  const { makeZip } = await import('./helpers/zip-writer.ts');
  const fake = await fakeCreative();
  try {
    const deps = depsFor();
    const zip = path.join(tempDir('zip-input-'), '新建文件夹.zip');
    fs.writeFileSync(zip, makeZip([{ name: '新建文件夹/P01.mp4', data: 'video' }, { name: '新建文件夹/封面.png', data: 'png' }, { name: '新建文件夹/说明.txt', data: 't' }]));
    const dir = tempDir('upload-plan-');
    fs.writeFileSync(path.join(dir, 'request.json'), JSON.stringify({ files: [zip], progress: false, creator: '张天伟', producers: ['丁杰'] }));
    const summary = await planUpload(online(fake), undefined, path.join(dir, 'request.json'), path.join(dir, 'plan.json'), deps);
    assert.deepEqual(summary.items.map((i: any) => [i.name, i.type]).sort(), [['P01', '视频'], ['封面', '图片']]);
    assert.deepEqual(summary.skipped, [{ file: '新建文件夹.zip：新建文件夹/说明.txt', reason: 'CLS 不支持这种格式（.txt）' }]);
    const result = await runUpload(online(fake), summary.plan, deps);
    assert.equal(result.status, 'uploaded', JSON.stringify(result));
    assert.deepEqual(fake.requests.find(r => r.path === '/api/qcloud/signed-url')!.body!.files.sort(), ['P01/P01.mp4', '封面/封面.png']);
  } finally { fake.close(); }
});

test('the 终稿库 example: each video goes up named as the row the requirement says it is, two rows of one name told apart by their numbers', async () => {
  const snapshot = new Snapshot(finalCutSheet());
  const rows = progressRowsFrom(snapshot, [56890, 44065, 67680, 67681, 67682, 67683, 67684]);
  assert.equal(rows.get(67682)![0]!.name, 'GOFCN67682_AI生成_设定3.0_3D_围炉煮冰');
  assert.equal(rows.get(67683)![0]!.name, 'GOFCN67683_AI生成_设定3.0_3D_围炉煮冰');
  assert.equal(rows.get(67684)![0]!.name, 'GOFCN67684_AI生成_设定3.0_关键词', 'SUBSTITUTE(CONCATENATE(…),"__","_") as the sheet shows it');
  const { materials: found, skipped } = await hashed([materials(FINAL_CUT_FILES)]);
  const build = (request: Record<string, unknown>, existing = new Set<string>()) =>
    buildUploadPlan({ request: normalizeUploadRequest({ files: ['unused'], ...request }), options: OPTIONS, materials: found, skipped, existing, progress: rows });

  // As they come out of the zip, none of the names is a 素材名称 and none carries a GOFCN number: all four are asked about at once.
  assert.throws(() => build({}), (error: Error) => /也不带 GOFCN 编号.*g44065_gf_v90\.mp4、g44065_v90\.mp4、g56890_a_v15\.mp4、g56890_c_v21\.mp4/.test(error.message));
  // The sheet's supplier is not CLS's name for it: the refusal says so and how to name it.
  assert.throws(() => build({ items: FINAL_CUT_ITEMS }), /制作人“廿十一”.*进度表 GOFCN6768\d 的设计师供应商.*producers 写明 CLS 的名字/);

  const plan = build({ producers: ['长沙廿拾一文化传媒有限公司'], items: FINAL_CUT_ITEMS });
  const by = Object.fromEntries(plan.items.map((i: any) => [i.file_name, i]));
  assert.deepEqual(Object.fromEntries(Object.entries(by).map(([file, i]: [string, any]) => [file, [i.name, i.upload_name]])), {
    'g56890_a_v15.mp4': ['GOFCN67680_AI生成_设定3.0_3D_企鹅保龄球', 'GOFCN67680_AI生成_设定3.0_3D_企鹅保龄球.mp4'],
    'g56890_c_v21.mp4': ['GOFCN67681_AI生成_设定3.0_3D_冻鱼飞盘', 'GOFCN67681_AI生成_设定3.0_3D_冻鱼飞盘.mp4'],
    'g44065_v90.mp4': ['GOFCN67682_AI生成_设定3.0_3D_围炉煮冰', 'GOFCN67682_AI生成_设定3.0_3D_围炉煮冰.mp4'],
    'g44065_gf_v90.mp4': ['GOFCN67683_AI生成_设定3.0_3D_围炉煮冰', 'GOFCN67683_AI生成_设定3.0_3D_围炉煮冰.mp4'],
  });
  assert.ok(plan.items.every((i: any) => i.creator.name === '金莉' && i.source.creator === 'progress' && i.source.progress_row.by === 'item'));
  assert.equal(by['g56890_a_v15.mp4'].renamed_from, 'g56890_a_v15');
  assert.equal(by['g56890_a_v15.mp4'].number, 67680);
  const summary = uploadPlanSummary(plan, 'plan.json');
  assert.equal(summary.renamed, 4);
  assert.deepEqual(summary.items.find((i: any) => i.file === 'g44065_gf_v90.mp4'),
    { file: 'g44065_gf_v90.mp4', name: 'GOFCN67683_AI生成_设定3.0_3D_围炉煮冰', renamed: true, type: '视频', creator: '金莉', producers: ['长沙廿拾一文化传媒有限公司'], progress_row: '26年1月-GOFCN 第 7 行', row_from: 'request' });
  // Rows without a 设计师供应商: finished materials were made by someone, so the 制作人 is asked for, never CLS's 待定供应商.
  const open = new Map([...rows].map(([n, list]) => [n, list.map(r => ({ ...r, supplier: '' }))]));
  const options = { ...OPTIONS, producers: [...OPTIONS.producers, { id: 51, name: '待定供应商' }] };
  assert.throws(() => buildUploadPlan({ request: normalizeUploadRequest({ files: ['unused'], items: FINAL_CUT_ITEMS }), materials: found, skipped,
    options, existing: new Set<string>(), progress: open }), /制作人未定（进度表 GOFCN67680 的设计师供应商为空，供应商就是审核人本人时进度表留空：问用户素材是谁做的/);
  const named = buildUploadPlan({ request: normalizeUploadRequest({ files: ['unused'], producers: ['廿拾一文化'], items: FINAL_CUT_ITEMS }), materials: found, skipped,
    options, existing: new Set<string>(), progress: open });
  assert.ok(named.items.every((i: any) => i.producers.map((p: any) => p.name).join() === '长沙廿拾一文化传媒有限公司' && i.source.producers === 'request'));
});

test('binding a file to a row: one file per row, an original\'s number in a file name is caught, a file already named right is left as it is', async () => {
  const rows = progressRowsFrom(new Snapshot(finalCutSheet()), [56890, 44065, 67680, 67681, 67682, 67683]);
  const plan = async (files: Record<string, string>, request: Record<string, unknown>, existing: string[] = []) => {
    const { materials: found, skipped } = await hashed([materials(files)]);
    return buildUploadPlan({ request: normalizeUploadRequest({ files: ['unused'], producers: ['长沙廿拾一文化传媒有限公司'], ...request }), options: OPTIONS,
      materials: found, skipped, existing: new Set(existing), progress: rows });
  };
  await assert.rejects(plan({ 'a.mp4': '1', 'b.mp4': '2' }, { items: [{ file: 'a.mp4', number: 67682 }, { file: 'b.mp4', number: 67682 }] }), /两个文件对应进度表同一行 GOFCN67682（a\.mp4、b\.mp4）/);
  await assert.rejects(plan({ 'a.mp4': '1' }, { items: [{ file: 'a.mp4', number: 67999 }] }), (error: Error) => /进度表里没有 GOFCN67999：a\.mp4/.test(error.message));
  // Named like the 终稿库 headings, the number is the original the piece builds on (GOFCN56890). Whether or not CLS has that creative under
  // the row's name (earlier uploads were named after their files), the file is not put up under the original's name.
  const original = 'GOFCN56890_汉化_竞争对抗_3D_火车运输御敌-斜';
  for (const existing of [[original], [], ['GOFCN56890_火车运输_终版']]) {
    await assert.rejects(plan({ 'GOFCN56890_企鹅保龄球_V15.mp4': 'p' }, {}, existing), /这个编号可能是它参考的初版.*：GOFCN56890_企鹅保龄球_V15\.mp4/);
  }
  const bound = await plan({ 'GOFCN56890_企鹅保龄球_V15.mp4': 'p' }, { items: [{ file: 'GOFCN56890_企鹅保龄球_V15.mp4', number: 67680 }] }, [original]);
  assert.equal(bound.items[0].name, 'GOFCN67680_AI生成_设定3.0_3D_企鹅保龄球', 'the row the request names wins over the number in the file name');
  await assert.rejects(plan({ 'x.mp4': 'p' }, { items: [{ file: 'x.mp4', number: 67680 }] }, ['GOFCN67680_AI生成_设定3.0_3D_企鹅保龄球']), /CLS 已有这一行的创意/);
  const right = await plan({ 'GOFCN67681_AI生成_设定3.0_3D_冻鱼飞盘.mp4': 'f' }, {});
  assert.equal(right.items[0].name, 'GOFCN67681_AI生成_设定3.0_3D_冻鱼飞盘');
  assert.equal(right.items[0].renamed_from, undefined);
  assert.equal(right.items[0].upload_name, undefined);
  assert.equal(uploadPlanSummary(right, 'p.json').renamed, undefined);
  await assert.rejects(plan({ 'GOFCN67681_AI生成_设定3.0_3D_冻鱼飞盘.mp4': 'f' }, {}, ['GOFCN67681_AI生成_设定3.0_3D_冻鱼飞盘']), /这个文件像是已经传过/, 'sent again: already up');
});

test('rows the sheet cannot name: alike duplicates are one row, items[].sheet picks a tab, and only a row without a usable name takes items[].name', async () => {
  const file = path.join(tempDir('progress-dup-'), 'progress.xlsx');
  fs.writeFileSync(file, makeXlsx([
    { name: '26年1月-GOFCN', rows: [HEADER, progressRow(2, 66909, '饮料睡袋', ['AI生成', '设定3.0', '2D'], ['廿十一', '金莉']),
      progressRow(3, 66910, '冰雕', ['AI生成', '设定3.0', '2D'], ['廿十一', '金莉']),
      [null, null, 66913, '丁杰的片子', null, null, null, 'AI生成', '设定3.0', null, '2D', null, '廿十一', '金莉'],
      [null, null, 66914, '横版', null, null, 'GOFCN66914_AI生成_横版/竖版', 'AI生成', '设定3.0', null, '2D', null, '廿十一', '金莉']] },
    { name: '26年2月-GOFCN', rows: [HEADER, progressRow(2, 66909, '饮料睡袋', ['AI生成', '设定3.0', '2D'], ['廿十一', '金莉']),
      progressRow(3, 66910, '冰雕', ['AI生成', '设定3.0', '2D'], ['长沙廿拾一文化传媒有限公司', '金莉'])] },
  ]));
  const rows = progressRowsFrom(new Snapshot(file), [66909, 66910, 66913, 66914]);
  const plan = async (items: Record<string, unknown>[]) => {
    const { materials: found, skipped } = await hashed([materials({ 'a.mp4': 'a' })]);
    return buildUploadPlan({ request: normalizeUploadRequest({ files: ['unused'], producers: ['长沙廿拾一文化传媒有限公司'], items }), options: OPTIONS,
      materials: found, skipped, existing: new Set(), progress: rows });
  };
  assert.equal((await plan([{ file: 'a.mp4', number: 66909 }])).items[0].name, 'GOFCN66909_AI生成_设定3.0_2D_饮料睡袋', 'carried into the next month alike: one row');
  await assert.rejects(plan([{ file: 'a.mp4', number: 66910 }]), /GOFCN66910 有 2 行，内容不同.*用 items\[\]\.sheet 写明/);
  const picked = await plan([{ file: 'a.mp4', number: 66910, sheet: '26年2月-GOFCN' }]);
  assert.deepEqual([picked.items[0].source.progress_row.sheet, picked.items[0].name], ['26年2月-GOFCN', 'GOFCN66910_AI生成_设定3.0_2D_冰雕']);
  await assert.rejects(plan([{ file: 'a.mp4', number: 66910, sheet: '25年12月-GOFCN' }]), /分表“25年12月-GOFCN”里没有 GOFCN66910（它在 26年1月-GOFCN、26年2月-GOFCN）/);
  await assert.rejects(plan([{ file: 'a.mp4', number: 66913 }]), /GOFCN66913.*素材名称为空或算不出来：请用户在进度表补正后重新做计划，或确认一个名称后用 items\[\]\.name 写明/);
  const confirmed = await plan([{ file: 'a.mp4', number: 66913, name: 'GOFCN66913_AI生成_设定3.0_2D_丁杰的片子' }]);
  assert.deepEqual([confirmed.items[0].name, confirmed.items[0].source.name], ['GOFCN66913_AI生成_设定3.0_2D_丁杰的片子', 'item']);
  await assert.rejects(plan([{ file: 'a.mp4', number: 66914 }]), /素材名称含 \/ 或 \\/);
  assert.equal((await plan([{ file: 'a.mp4', number: 66914, name: 'GOFCN66914_AI生成_横版竖版' }])).items[0].name, 'GOFCN66914_AI生成_横版竖版');
  await assert.rejects(plan([{ file: 'a.mp4', number: 66909, name: '另起的名字' }]), /名称以进度表为准：去掉 items\[\]\.name/);
});

test('files of the same name in two zips are told apart by zip, and a refusal names every file that needs a row', async () => {
  const { makeZip } = await import('./helpers/zip-writer.ts');
  const root = tempDir('zip-same-'), a = path.join(root, '供应商A.zip'), b = path.join(root, '供应商B.zip');
  fs.writeFileSync(a, makeZip([{ name: '01.mp4', data: 'a' }]));
  fs.writeFileSync(b, makeZip([{ name: '01.mp4', data: 'b' }, ...Array.from({ length: 11 }, (_, i) => ({ name: `${String(i + 2).padStart(2, '0')}.mp4`, data: `b${i}` }))]));
  const unpacked = new Map<string, string>();
  for (const zip of [a, b]) unpacked.set(zip.toLowerCase(), (await unpackZip(zip, path.join(root, 'unpacked'), materialRefusal)).dir);
  const scanned = scanMaterials([a, b], unpacked);
  const found: Awaited<ReturnType<typeof hashed>>['materials'] = [];
  for (const m of scanned.materials) found.push({ ...m, ...(await hashFile(m.file)) });
  const rows = progressRowsFrom(new Snapshot(finalCutSheet()), [67680, 67681]);
  const plan = (items: Record<string, unknown>[]) => buildUploadPlan({ request: normalizeUploadRequest({ files: [a, b], producers: ['长沙廿拾一文化传媒有限公司'], items }),
    options: OPTIONS, materials: found, skipped: scanned.skipped, existing: new Set(), progress: rows });
  assert.throws(() => plan([{ file: '01.mp4', number: 67680 }]), /items 里的“01\.mp4”对应多个文件（供应商A\.zip：01\.mp4、供应商B\.zip：01\.mp4），写成其中一个/);
  assert.throws(() => plan([]), (error: Error) => ['供应商A.zip：01.mp4', '供应商B.zip：01.mp4', '供应商B.zip：12.mp4'].every(f => error.message.includes(f)) && !error.message.includes('等 '),
    'all 13 files are named, by zip');
  const rest = Array.from({ length: 11 }, (_, i) => ({ file: `${String(i + 2).padStart(2, '0')}.mp4`, skip: true }));
  const done = plan([{ file: '供应商A.zip：01.mp4', number: 67680 }, { file: '供应商B.zip：01.mp4', number: 67681 }, ...rest]);
  assert.deepEqual(done.items.map((i: any) => [i.origin, i.name]), [['供应商A.zip：01.mp4', 'GOFCN67680_AI生成_设定3.0_3D_企鹅保龄球'], ['供应商B.zip：01.mp4', 'GOFCN67681_AI生成_设定3.0_3D_冻鱼飞盘']]);
  assert.deepEqual(uploadPlanSummary(done, 'p.json').items.map((i: any) => i.file), ['供应商A.zip：01.mp4', '供应商B.zip：01.mp4']);
});

test('rows: by number and by text in 素材名称 or 提炼词, newest first; numbers not on the sheet are said', async () => {
  const snapshot = new Snapshot(finalCutSheet());
  const found = searchProgressRows(snapshot, [67683, 99999], ['围炉煮冰', '企鹅保龄球']);
  assert.deepEqual(found.rows.map(r => r.number), [67683, 67682, 67680], 'the numbers asked for first, then the text hits not already listed');
  assert.deepEqual(found.not_found, [99999]);
  assert.equal(found.rows[0]!.keyword, '围炉煮冰');
  assert.deepEqual(searchProgressRows(snapshot, [], ['转斧杀熊']).rows.map(r => [r.number, r.name, r.primary_tag, r.supplier, r.reviewer]),
    [[44065, 'GOFCN44065_汉化_资源城建_3D_转斧杀熊烤肉', '汉化', '廿十一', '金莉']]);
  const exports: string[] = [];
  const listed = await findRows(sheetBridge(finalCutSheet(), exports), { numbers: [67680, 67681], texts: [] }, { tmpDir: tempDir('rows-tmp-') });
  assert.equal(listed.status, 'progress_rows');
  assert.deepEqual(listed.rows.map((r: any) => [r.number, r.name, r.where]), [
    [67680, 'GOFCN67680_AI生成_设定3.0_3D_企鹅保龄球', '26年1月-GOFCN 第 4 行'], [67681, 'GOFCN67681_AI生成_设定3.0_3D_冻鱼飞盘', '26年1月-GOFCN 第 5 行']]);
  assert.equal(exports.length, 1);
  assert.ok(!fs.existsSync(exports[0]!), 'the export is removed again');
  await assert.rejects(findRows(sheetBridge(finalCutSheet()), { numbers: [], texts: [] }), /--numbers 或 --find/);
});

test('files --check: a file named with its number is found in the progress sheet, or said to differ from its row, or to have none', async () => {
  const dir = materials({
    'GOFCN67680_AI生成_设定3.0_3D_企鹅保龄球.mp4': 'registered', 'GOFCN67681_AI生成_设定3.0_3D_冻鱼飞盘_竖版.mp4': 'variant',
    'GOFCN67682_AI生成_设定3.0_3D_企鹅保龄球.mp4': 'differs', 'GOFCN99999_AI生成_设定3.0_3D_冻鱼飞盘.mp4': 'missing', '01.mp4': 'plain',
  });
  const exports: string[] = [];
  const listed = await listFiles([dir], { tmpDir: tempDir('files-tmp-') }, { bridge: sheetBridge(finalCutSheet(), exports), progress: true });
  const row = (name: string) => listed.files.find((f: any) => f.name === name).row;
  assert.deepEqual(row('GOFCN67680_AI生成_设定3.0_3D_企鹅保龄球'),
    { status: 'registered', rows: [{ number: 67680, name: 'GOFCN67680_AI生成_设定3.0_3D_企鹅保龄球', where: '26年1月-GOFCN 第 4 行' }] });
  assert.deepEqual(row('GOFCN67681_AI生成_设定3.0_3D_冻鱼飞盘_竖版'),
    { status: 'variant', rows: [{ number: 67681, name: 'GOFCN67681_AI生成_设定3.0_3D_冻鱼飞盘', where: '26年1月-GOFCN 第 5 行' }] });
  assert.deepEqual(row('GOFCN67682_AI生成_设定3.0_3D_企鹅保龄球'), { status: 'differs',
    rows: [{ number: 67682, name: 'GOFCN67682_AI生成_设定3.0_3D_围炉煮冰', where: '26年1月-GOFCN 第 6 行' }],
    same_name_rows: [{ number: 67680, name: 'GOFCN67680_AI生成_设定3.0_3D_企鹅保龄球', where: '26年1月-GOFCN 第 4 行' }] });
  assert.deepEqual(row('GOFCN99999_AI生成_设定3.0_3D_冻鱼飞盘'),
    { status: 'not_found', same_name_rows: [{ number: 67681, name: 'GOFCN67681_AI生成_设定3.0_3D_冻鱼飞盘', where: '26年1月-GOFCN 第 5 行' }] });
  assert.equal(row('01'), undefined, 'a file without a number is not looked for');
  assert.deepEqual([listed.progress_source, listed.registered, listed.to_verify], ['插件进度表', 1, 3]);
  assert.equal(exports.length, 1);
  // GOFCNxxxxx_… files are found by their name without the number; without --check nothing is read.
  const pending = await listFiles([materials(PENDING)], { tmpDir: tempDir('files-tmp-') }, { bridge: sheetBridge(registeredSheet()), progress: true });
  assert.deepEqual(pending.files.map((f: any) => [f.row.status, f.row.rows[0].number]).sort(), [['registered', 67738], ['registered', 67739], ['registered', 67740]]);
  const offline = await listFiles([dir], { tmpDir: tempDir('files-tmp-') });
  assert.ok(offline.files.every((f: any) => f.row === undefined) && !('registered' in offline));
});

test('the 终稿库 zip end to end: planned from the progress sheet, uploaded under the 素材名称, the files on disk untouched', async () => {
  const { makeZip } = await import('./helpers/zip-writer.ts');
  const fake = await fakeCreative();
  try {
    const deps = depsFor();
    const zip = path.join(tempDir('zip-input-'), '玩法AI迭代素材.zip');
    fs.writeFileSync(zip, makeZip(Object.entries(FINAL_CUT_FILES).map(([name, data]) => ({ name, data }))));
    const before = fs.readFileSync(zip);
    const file = await approvedPlan(fake, deps, { files: [zip], progress: true, producers: ['长沙廿拾一文化传媒有限公司'], items: FINAL_CUT_ITEMS }, sheetBridge(finalCutSheet()));
    const result = await runUpload(online(fake), file, deps);
    assert.equal(result.status, 'uploaded', JSON.stringify(result));
    const signed: string[] = fake.requests.find(r => r.path === '/api/qcloud/signed-url')!.body!.files;
    assert.deepEqual([...signed].sort(), [
      'GOFCN67680_AI生成_设定3.0_3D_企鹅保龄球/GOFCN67680_AI生成_设定3.0_3D_企鹅保龄球.mp4',
      'GOFCN67681_AI生成_设定3.0_3D_冻鱼飞盘/GOFCN67681_AI生成_设定3.0_3D_冻鱼飞盘.mp4',
      'GOFCN67682_AI生成_设定3.0_3D_围炉煮冰/GOFCN67682_AI生成_设定3.0_3D_围炉煮冰.mp4',
      'GOFCN67683_AI生成_设定3.0_3D_围炉煮冰/GOFCN67683_AI生成_设定3.0_3D_围炉煮冰.mp4',
    ]);
    assert.ok([...fake.objects.keys()].every(key => /\/GOFCN6768[0-3]_AI生成_设定3\.0_3D_.+\.mp4$/.test(key)), 'the stored files carry the new names');
    assert.deepEqual([...fake.requests.find(r => r.path === '/api/creative/multiple-upload')!.body!.names].sort(), signed.map(k => k.split('/')[0]).sort());
    assert.deepEqual(Object.fromEntries(result.uploaded.map((u: any) => [u.file, u.name])), {
      'g56890_a_v15.mp4': 'GOFCN67680_AI生成_设定3.0_3D_企鹅保龄球', 'g56890_c_v21.mp4': 'GOFCN67681_AI生成_设定3.0_3D_冻鱼飞盘',
      'g44065_v90.mp4': 'GOFCN67682_AI生成_设定3.0_3D_围炉煮冰', 'g44065_gf_v90.mp4': 'GOFCN67683_AI生成_设定3.0_3D_围炉煮冰',
    });
    // The 国风配乐 version is a creative of its own: the same name as the V90 but for its number, and its own file.
    const guofeng = [...fake.creatives.values()].find(c => c.name === 'GOFCN67683_AI生成_设定3.0_3D_围炉煮冰')!;
    assert.equal(guofeng.materials[0].file_hash, (await hashFile(path.join(materials({ x: 'guofeng' }), 'x'))).md5);
    assert.ok(result.uploaded.every((u: any) => u.creator === '金莉' && u.producers[0] === '长沙廿拾一文化传媒有限公司'));
    assert.ok(fs.readFileSync(zip).equals(before), 'the zip the user sent is not changed');
  } finally { fake.close(); }
});

/** The production sheet after the files of 玩法AI迭代素材 were registered: rows named GOFCN<编号>_<一级>_<二级>_<提炼词>, the newest formula. */
function registeredSheet(extra: unknown[][] = []): string {
  const file = path.join(tempDir('progress-'), 'progress.xlsx');
  const row = (r: number, number: number, tags: [string, string], keyword: string) =>
    [null, null, number, keyword, null, null, { f: `CONCATENATE("GOFCN",C${r},"_",H${r},"_",I${r},"_",D${r})` }, tags[0], tags[1], null, null, null, '廿十一', '金莉'];
  fs.writeFileSync(file, makeXlsx([{ name: '26年1月-GOFCN', rows: [HEADER,
    row(2, 67738, ['AI玩法优化', '搂冰块抢资源'], '割资源冰块对抗_竖版'),
    row(3, 67739, ['AI玩法优化', '火车运输御敌'], '兵临城下塔防_企鹅_竖版'),
    row(4, 67740, ['AI玩法优化', '火车运输御敌'], '兵临城下塔防_冻鱼_竖版'),
    ...extra.map((cells, i) => (cells as any[]).length ? row(5 + i, ...(cells as [number, [string, string], string])) : []),
  ] }]));
  return file;
}
const PENDING = { 'GOFCNxxxxx_AI玩法优化_搂冰块抢资源_割资源冰块对抗_竖版.mp4': 'ice', 'GOFCNxxxxx_AI玩法优化_火车运输御敌_兵临城下塔防_企鹅_竖版.mp4': 'penguin',
  'GOFCNxxxxx_AI玩法优化_火车运输御敌_兵临城下塔防_冻鱼_竖版.mp4': 'fish' };

test('files named GOFCNxxxxx_… before their rows existed go up as those rows once they do, the number filled in', async () => {
  assert.deepEqual([pendingBody('GOFCNxxxxx_AI玩法优化_搂冰块'), pendingBody('GOFCN_a_b'), pendingBody('GOFCN67738_a_b'), pendingBody('01')], ['AI玩法优化_搂冰块', 'a_b', null, null]);
  // Read the way materials are named: 一级_二级_[创意形式_]提炼词; everything after the tags is `rest`, 竖版 / 横版 included.
  assert.deepEqual(nameParts('AI玩法优化_火车运输御敌_兵临城下塔防_企鹅_竖版'), { primary_tag: 'AI玩法优化', secondary_tag: '火车运输御敌', rest: '兵临城下塔防_企鹅_竖版' });
  assert.deepEqual(nameParts('AI生成_设定3.0_3D_围炉_煮冰_横板'), { primary_tag: 'AI生成', secondary_tag: '设定3.0', rest: '3D_围炉_煮冰_横板' });
  assert.deepEqual(nameParts('AI玩法优化_搂冰块抢资源_割资源冰块对抗_竖版'), { primary_tag: 'AI玩法优化', secondary_tag: '搂冰块抢资源', rest: '割资源冰块对抗_竖版' });
  assert.ok('unclear' in nameParts('AI玩法优化_搂冰块抢资源'));
  assert.ok('unclear' in nameParts('AI玩法优化__企鹅'));
  const dir = materials(PENDING);
  const listed = await listFiles([dir], { tmpDir: tempDir('files-tmp-') });
  assert.equal(listed.files.find((f: any) => f.name.includes('企鹅')).parts.rest, '兵临城下塔防_企鹅_竖版');
  assert.deepEqual(listed.files.map((f: any) => [f.name_without_number, f.pending_number, f.kind]).sort(), Object.keys(PENDING)
    .map(name => [name.replace(/^GOFCNxxxxx_/, '').replace(/.mp4$/, ''), true, 'video']).sort());
  const fake = await fakeCreative();
  try {
    const deps = depsFor();
    const file = await approvedPlan(fake, deps, { files: [dir], progress: true, producers: ['长沙廿拾一文化传媒有限公司'] }, sheetBridge(registeredSheet()));
    const plan = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(plan.items.map((i: any) => [i.name, i.source.progress_row.by, i.renamed_from !== undefined]).sort(), [
      ['GOFCN67738_AI玩法优化_搂冰块抢资源_割资源冰块对抗_竖版', 'name', true], ['GOFCN67739_AI玩法优化_火车运输御敌_兵临城下塔防_企鹅_竖版', 'name', true],
      ['GOFCN67740_AI玩法优化_火车运输御敌_兵临城下塔防_冻鱼_竖版', 'name', true]]);
    assert.ok(plan.items.every((i: any) => i.creator.name === '金莉'), '创意人 from the row');
    const result = await runUpload(online(fake), file, deps);
    assert.equal(result.status, 'uploaded', JSON.stringify(result));
    assert.ok(fake.requests.find(r => r.path === '/api/qcloud/signed-url')!.body!.files
      .includes('GOFCN67739_AI玩法优化_火车运输御敌_兵临城下塔防_企鹅_竖版/GOFCN67739_AI玩法优化_火车运输御敌_兵临城下塔防_企鹅_竖版.mp4'));
  } finally { fake.close(); }
});

test('a GOFCNxxxxx_… file without its row is to be registered first, and one of two rows of its name is named by number', async () => {
  const snapshot = new Snapshot(registeredSheet([[67741, ['AI玩法优化', '搂冰块抢资源'], '割资源冰块对抗_竖版']]));
  const plan = async (files: Record<string, string>, items: Record<string, unknown>[] = []) => {
    const { materials: found, skipped } = await hashed([materials(files)]);
    const bodies = found.map(m => pendingBody(m.name)).filter((b): b is string => b !== null);
    const { byNumber, byBody } = lookupRows(snapshot, items.map(i => Number(i.number)).filter(Boolean), bodies);
    return buildUploadPlan({ request: normalizeUploadRequest({ files: ['unused'], producers: ['长沙廿拾一文化传媒有限公司'], items }), options: OPTIONS,
      materials: found, skipped, existing: new Set(), progress: byNumber, named: byBody });
  };
  await assert.rejects(plan({ 'GOFCNxxxxx_AI玩法优化_转斧杀熊烤肉_杀熊订单_国风配乐_竖版.mp4': 'g' }),
    /进度表里还没有素材名称为“GOFCN<编号>_AI玩法优化_转斧杀熊烤肉_杀熊订单_国风配乐_竖版”的行：这批素材要先登记/);
  const twice = { 'GOFCNxxxxx_AI玩法优化_搂冰块抢资源_割资源冰块对抗_竖版.mp4': 'ice' };
  await assert.rejects(plan(twice), /有 2 行的素材名称是“GOFCN<编号>_AI玩法优化_搂冰块抢资源_割资源冰块对抗_竖版”（GOFCN67738、GOFCN67741）：用 items\[\]\.number 写明/);
  const picked = await plan(twice, [{ file: 'GOFCNxxxxx_AI玩法优化_搂冰块抢资源_割资源冰块对抗_竖版.mp4', number: 67741 }]);
  assert.deepEqual([picked.items[0].name, picked.items[0].source.progress_row.by], ['GOFCN67741_AI玩法优化_搂冰块抢资源_割资源冰块对抗_竖版', 'item']);
});

/**
 * 合并变体名称: the AI剧情 pieces registered as one row each (提炼词 = the first part of the files' names), and a piece registered so for
 * files named GOFCNxxxxx_…; the variants of each go up under the row's 素材名称 and their own ending.
 */
function variantSheet(extra: unknown[][] = []): string {
  const file = path.join(tempDir('progress-'), 'progress.xlsx');
  const row = (r: number, number: number, tags: [string, string], keyword: string) =>
    [null, null, number, keyword, null, null, { f: `CONCATENATE("GOFCN",C${r},"_",H${r},"_",I${r},"_",D${r})` }, tags[0], tags[1], null, null, null, '廿十一', '金莉'];
  fs.writeFileSync(file, makeXlsx([{ name: '26年1月-GOFCN', rows: [HEADER,
    row(2, 67076, ['AI剧情', '短剧表达'], '原生家庭WM'),
    row(3, 67146, ['AI剧情', '短剧表达'], '得加钱WM'),
    row(4, 67750, ['AI玩法优化', '火车运输御敌'], '兵临城下塔防'),
    ...extra.map((cells, i) => row(5 + i, ...(cells as [number, [string, string], string]))),
  ] }]));
  return file;
}
const VARIANTS = {
  'GOFCN67076_AI剧情_短剧表达_原生家庭WM_剧情衔接_割资源冰块对抗_竖版.mp4': 'ice', 'GOFCN67076_AI剧情_短剧表达_原生家庭WM_剧情衔接_剧情叙事_竖版.mp4': 'story',
  'GOFCN67146_AI剧情_短剧表达_得加钱WM熔炉版_剧情衔接_割资源冰块对抗_竖版.mp4': 'furnace',
  'GOFCNxxxxx_AI剧情_短剧表达_得加钱WM熔炉版_剧情衔接_扩岛对抗_竖版.mp4': 'furnace-island',
  'GOFCNxxxxx_AI玩法优化_火车运输御敌_兵临城下塔防_冻鱼_竖版.mp4': 'fish', 'GOFCNxxxxx_AI玩法优化_火车运输御敌_兵临城下塔防_企鹅_竖版.mp4': 'penguin',
  '01.mp4': 'island',
};

test('合并变体名称: several files of one row go up as <素材名称>_<变体>, their names kept or the number filled in; off, nothing changes', async () => {
  assert.deepEqual(variantBases('AI剧情_短剧表达_原生家庭WM_剧情衔接_竖版').slice(0, 2), ['AI剧情_短剧表达_原生家庭WM_剧情衔接', 'AI剧情_短剧表达_原生家庭WM'], 'cut at _ first, longest first');
  assert.deepEqual(variantBases('AI剧情_短剧表达_得加钱WM'), ['AI剧情_短剧表达_得加钱W', 'AI剧情_短剧表达_得加钱', 'AI剧情_短剧表达_得加', 'AI剧情_短剧表达_得']);
  assert.ok(variantBases('AI剧情_短剧表达_得加钱WM熔炉版_剧情衔接').includes('AI剧情_短剧表达_得加钱WM'), 'the first word cut short');
  assert.ok(variantBases('AI生成_设定3.0_3D_企鹅保龄球_竖版').includes('AI生成_设定3.0_3D_企鹅'), 'or the first word after a 创意形式');
  const fake = await fakeCreative();
  try {
    const deps = depsFor();
    const dir = materials(VARIANTS);
    const request = { files: [dir], progress: true, producers: ['长沙廿拾一文化传媒有限公司'], items: [{ file: '01.mp4', number: 67076 }] };
    const file = await approvedPlan(fake, deps, { ...request, variants: true, items: [{ file: '01.mp4', number: 67076, variant: '剧情衔接_扩岛对抗_竖版' }] }, sheetBridge(variantSheet()));
    const plan = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(Object.fromEntries(plan.items.map((i: any) => [i.file_name, [i.name, i.variant, i.number, i.source.progress_row.by, i.source.variant, i.renamed_from !== undefined]])), {
      'GOFCN67076_AI剧情_短剧表达_原生家庭WM_剧情衔接_割资源冰块对抗_竖版.mp4':
        ['GOFCN67076_AI剧情_短剧表达_原生家庭WM_剧情衔接_割资源冰块对抗_竖版', '剧情衔接_割资源冰块对抗_竖版', 67076, 'file_name', 'file', false],
      'GOFCN67076_AI剧情_短剧表达_原生家庭WM_剧情衔接_剧情叙事_竖版.mp4':
        ['GOFCN67076_AI剧情_短剧表达_原生家庭WM_剧情衔接_剧情叙事_竖版', '剧情衔接_剧情叙事_竖版', 67076, 'file_name', 'file', false],
      // Numbered as its row and starting with its name, the file keeps its name: what follows is the variant, _ or not.
      'GOFCN67146_AI剧情_短剧表达_得加钱WM熔炉版_剧情衔接_割资源冰块对抗_竖版.mp4':
        ['GOFCN67146_AI剧情_短剧表达_得加钱WM熔炉版_剧情衔接_割资源冰块对抗_竖版', '熔炉版_剧情衔接_割资源冰块对抗_竖版', 67146, 'file_name', 'file', false],
      // Without a number, a first word that starts with a row's (得加钱WM熔炉版, 得加钱WM) is a variant of that row too.
      'GOFCNxxxxx_AI剧情_短剧表达_得加钱WM熔炉版_剧情衔接_扩岛对抗_竖版.mp4':
        ['GOFCN67146_AI剧情_短剧表达_得加钱WM熔炉版_剧情衔接_扩岛对抗_竖版', '熔炉版_剧情衔接_扩岛对抗_竖版', 67146, 'name', 'file', true],
      'GOFCNxxxxx_AI玩法优化_火车运输御敌_兵临城下塔防_冻鱼_竖版.mp4':
        ['GOFCN67750_AI玩法优化_火车运输御敌_兵临城下塔防_冻鱼_竖版', '冻鱼_竖版', 67750, 'name', 'file', true],
      'GOFCNxxxxx_AI玩法优化_火车运输御敌_兵临城下塔防_企鹅_竖版.mp4':
        ['GOFCN67750_AI玩法优化_火车运输御敌_兵临城下塔防_企鹅_竖版', '企鹅_竖版', 67750, 'name', 'file', true],
      '01.mp4': ['GOFCN67076_AI剧情_短剧表达_原生家庭WM_剧情衔接_扩岛对抗_竖版', '剧情衔接_扩岛对抗_竖版', 67076, 'item', 'item', true],
    });
    const summary = uploadPlanSummary(plan, file);
    assert.deepEqual([summary.count, summary.rows, summary.renamed], [7, 3, 4]);
    assert.equal(summary.items.find((i: any) => i.file === '01.mp4').variant, '剧情衔接_扩岛对抗_竖版');
    const result = await runUpload(online(fake), file, deps);
    assert.equal(result.status, 'uploaded', JSON.stringify(result));
    assert.deepEqual(result.uploaded.map((u: any) => u.name).sort(), plan.items.map((i: any) => i.name).sort());
    assert.ok(fake.requests.find(r => r.path === '/api/qcloud/signed-url')!.body!.files
      .includes('GOFCN67750_AI玩法优化_火车运输御敌_兵临城下塔防_企鹅_竖版/GOFCN67750_AI玩法优化_火车运输御敌_兵临城下塔防_企鹅_竖版.mp4'));

    // Off (the default), each file is a row of its own name: the numbered ones are taken for originals, the others are to be registered.
    const off = path.join(tempDir('off-'), 'request.json');
    fs.writeFileSync(off, JSON.stringify(request));
    await assert.rejects(planUpload(online(fake), sheetBridge(variantSheet()), off, path.join(path.dirname(off), 'plan.json'), deps),
      (error: Error) => /这个编号可能是它参考的初版/.test(error.message) && /还没有素材名称为“GOFCN<编号>_AI玩法优化_火车运输御敌_兵临城下塔防_冻鱼_竖版”的行/.test(error.message)
        && !/变体/.test(error.message));
  } finally { fake.close(); }
});

test('合并变体名称: a row of the file\'s own name wins, two rows it may be a variant of or two files of one name are asked, the setting only with the sheet', async () => {
  const snapshot = new Snapshot(variantSheet([[67751, ['AI玩法优化', '火车运输御敌'], '兵临城下塔防_冻鱼_竖版'], [67752, ['AI剧情', '短剧表达'], '原生家庭WM_剧情衔接']]));
  const plan = async (files: Record<string, string>, items: Record<string, unknown>[] = [], variants = true) => {
    const { materials: found, skipped } = await hashed([materials(files)]);
    const bodies = found.map(m => pendingBody(m.name)).filter((b): b is string => b !== null).flatMap(b => [b, ...variantBases(b)]);
    const numbers = [...items.map(i => Number(i.number)).filter(Boolean), ...found.map(m => m.number).filter((n): n is number => n !== null)];
    const { byNumber, byBody } = lookupRows(snapshot, numbers, bodies);
    return buildUploadPlan({ request: normalizeUploadRequest({ files: ['unused'], producers: ['长沙廿拾一文化传媒有限公司'], variants, items }), options: OPTIONS,
      materials: found, skipped, existing: new Set(), progress: byNumber, named: byBody });
  };
  const own = await plan({ 'GOFCNxxxxx_AI玩法优化_火车运输御敌_兵临城下塔防_冻鱼_竖版.mp4': 'f' });
  assert.deepEqual([own.items[0].name, own.items[0].variant], ['GOFCN67751_AI玩法优化_火车运输御敌_兵临城下塔防_冻鱼_竖版', undefined], 'registered under its own name before');
  await assert.rejects(plan({ 'GOFCNxxxxx_AI剧情_短剧表达_原生家庭WM_剧情衔接_竖版.mp4': 'a' }),
    /可以是进度表几行的变体（GOFCN67752_AI剧情_短剧表达_原生家庭WM_剧情衔接；GOFCN67076_AI剧情_短剧表达_原生家庭WM）：用 items\[\]\.number 写明/);
  const picked = await plan({ 'GOFCNxxxxx_AI剧情_短剧表达_原生家庭WM_剧情衔接_竖版.mp4': 'a' }, [{ file: 'GOFCNxxxxx_AI剧情_短剧表达_原生家庭WM_剧情衔接_竖版.mp4', number: 67076 }]);
  assert.deepEqual([picked.items[0].name, picked.items[0].variant], ['GOFCN67076_AI剧情_短剧表达_原生家庭WM_剧情衔接_竖版', '剧情衔接_竖版']);
  // 得加钱WM熔炉版 registered as a row of its own: its files could be variants of either row.
  const both = new Snapshot(variantSheet([[67753, ['AI剧情', '短剧表达'], '得加钱WM熔炉版']]));
  const { materials: furnace, skipped: none } = await hashed([materials({ 'GOFCNxxxxx_AI剧情_短剧表达_得加钱WM熔炉版_剧情叙事_竖版.mp4': 'x' })]);
  const furnaceBody = 'AI剧情_短剧表达_得加钱WM熔炉版_剧情叙事_竖版';
  assert.throws(() => buildUploadPlan({ request: normalizeUploadRequest({ files: ['unused'], producers: ['长沙廿拾一文化传媒有限公司'], variants: true }), options: OPTIONS,
    materials: furnace, skipped: none, existing: new Set(), progress: new Map(), named: lookupRows(both, [], [furnaceBody, ...variantBases(furnaceBody)]).byBody }),
  /可以是进度表几行的变体（GOFCN67753_AI剧情_短剧表达_得加钱WM熔炉版；GOFCN67146_AI剧情_短剧表达_得加钱WM）/);
  await assert.rejects(plan({ 'GOFCNxxxxx_AI剧情_短剧表达_爆款WM_剧情衔接_竖版.mp4': 'a' }), /还没有素材名称为“GOFCN<编号>_AI剧情_短剧表达_爆款WM_剧情衔接_竖版”或它开头部分/);
  await assert.rejects(plan({ 'GOFCN67076_AI剧情_短剧表达_最大功率WM_剧情衔接_竖版.mp4': 'a' }), /和文件名不同，文件名也不以它开头（不是它的变体）/);
  await assert.rejects(plan({ '01.mp4': '1', '02.mp4': '2' }, [{ file: '01.mp4', number: 67076 }, { file: '02.mp4', number: 67076 }]),
    /两个文件会得到同一个创意名称“GOFCN67076_AI剧情_短剧表达_原生家庭WM”（01\.mp4、02\.mp4）：同一行的几个变体要各有变体名称/);
  const told = await plan({ '01.mp4': '1', '02.mp4': '2' }, [{ file: '01.mp4', number: 67076, variant: '剧情叙事' }, { file: '02.mp4', number: 67076 }]);
  assert.deepEqual(told.items.map((i: any) => i.name), ['GOFCN67076_AI剧情_短剧表达_原生家庭WM_剧情叙事', 'GOFCN67076_AI剧情_短剧表达_原生家庭WM'], 'a file without a variant is the row itself');
  await assert.rejects(plan({ '01.mp4': '1', '02.mp4': '2' }, [{ file: '01.mp4', number: 67076 }, { file: '02.mp4', number: 67076 }], false), /两个文件对应进度表同一行 GOFCN67076/);
  assert.throws(() => normalizeUploadRequest({ files: ['a'], items: [{ file: 'a', variant: 'x' }] }), /只在合并变体名称（variants: true）时有用/);
  assert.throws(() => normalizeUploadRequest({ files: ['a'], progress: false, variants: true }), /progress 不能是 false/);
  assert.throws(() => normalizeUploadRequest({ files: ['a'], variants: true, items: [{ file: 'a', name: 'n', variant: 'x' }] }), /name 和 variant 只能写一个/);
  for (const bad of ['_竖版', '竖版_', '剧情__竖版', '横/竖']) {
    assert.throws(() => normalizeUploadRequest({ files: ['a'], variants: true, items: [{ file: 'a', variant: bad }] }), /不能以 _ 开头或结尾/);
  }
  assert.throws(() => normalizeUploadRequest({ files: ['a'], variants: 'yes' }), /variants 只能是 true\/false/);
});
