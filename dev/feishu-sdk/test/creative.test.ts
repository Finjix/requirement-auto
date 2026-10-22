import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildUploadPlan, creativeName, findDirectory, loadUploadPlan, materialNumber, normalizeUploadRequest, progressRowsFrom, scanMaterials,
  uploadEvents, uploadPlanSummary, hashFile, type UploadOptions,
} from '../src/gof/creative.ts';
import { createCreativeAdapter } from '../src/gof/creative-adapter.ts';
import { planUpload, runUpload, uploadStatus, type UploadDeps } from '../src/gof/creative-online.ts';
import type { Online } from '../src/gof/cls-online.ts';
import { Snapshot } from '../src/gof/snapshot.ts';
import { Blocked } from '../src/gof/util.ts';
import { ACCOUNT, DIRS, fakeCreative, GAME, PEOPLE, TYPES, type FakeCreative } from './helpers/fake-creative.ts';
import { tempDir } from './helpers/tmp.ts';

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

async function approvedPlan(fake: FakeCreative, deps: UploadDeps, request: Record<string, unknown>): Promise<string> {
  const dir = tempDir('upload-plan-');
  fs.writeFileSync(path.join(dir, 'request.json'), JSON.stringify(request));
  const summary = await planUpload(online(fake), undefined, path.join(dir, 'request.json'), path.join(dir, 'plan.json'), deps);
  assert.equal(summary.status, 'upload_plan');
  return summary.plan;
}

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
  assert.deepEqual(normalizeUploadRequest({ files: ['a.mp4'], progress: false }), { files: ['a.mp4'] });
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
  const request = normalizeUploadRequest({ files: [dir], creator: '张天伟', producers: ['丁杰'], items: [{ file: 'b.jpg', creator: '雷佳威', producers: ['杨燃', '谢振文'], directory: '常规素材/图片' }] });
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

test('the plan says everything that is not settled, at once: no 创意人, ambiguous people, a taken or doubled name', async () => {
  const dir = materials({ 'a.mp4': '1', 'x.mp4': '2', 'x.png': '3' });
  const { materials: found, skipped } = await hashed([dir]);
  const build = (request: Record<string, unknown>, existing = new Set<string>()) =>
    buildUploadPlan({ request: normalizeUploadRequest({ files: [dir], ...request }), options: OPTIONS, materials: found, skipped, existing });
  assert.throws(() => build({ producers: ['丁杰'] }), (error: Error) => error instanceof Blocked && /创意人未定/.test(error.message) && /同一个创意名称“x”/.test(error.message));
  assert.throws(() => build({ creator: '李晨阳', producers: ['丁杰'], items: [{ file: 'x.png', skip: true }] }), /李晨阳.*不唯一/);
  const byId = build({ creator: '492', producers: ['丁杰'], items: [{ file: 'x.png', skip: true }] });
  assert.ok(byId.items.every((i: any) => i.creator.id === 492), 'a CLS user ID picks one of two people with the same name');
  assert.ok(byId.skipped.some((s: any) => s.reason === '按要求不上传'));
  assert.throws(() => build({ creator: '张天伟', producers: ['丁杰'], items: [{ file: 'x.png', skip: true }] }, new Set(["a"])), /CLS 已有同名创意.*：a$/);
  const renamed = build({ creator: '张天伟', producers: ['丁杰'], items: [{ file: 'x.png', name: 'x_封面' }] });
  assert.deepEqual(renamed.items.map((i: any) => i.name).sort(), ['a', 'x', 'x_封面']);
});

test('the progress sheet gives 创意人 (创意者脚本审核人) and 制作人 (设计师供应商) by material number; a missing or doubled number is asked', async () => {
  const snapshot = new Snapshot(path.join(here, 'fixtures', 'base.xlsx'));
  const rows = progressRowsFrom(snapshot, [1001, 1002, 1004, 9999]);
  assert.equal(rows.get(1001)!.length, 2, 'a number on two rows is two rows');
  assert.deepEqual(rows.get(1004), [{ sheet: 'GOFCN创意进度 26年3月', row: 2, number: 1004, supplier: '供应商甲', reviewer: '张三', name: rows.get(1004)![0]!.name }]);
  assert.match(rows.get(1004)![0]!.name!, /^GOFCN1004_/, 'the name comes out of the naming formula');
  assert.equal(rows.get(1002)![0]!.name, 'GOFCN1002_玩法_卖点_视频_爆点B');
  assert.equal(rows.has(9999), false);

  const people = { ...OPTIONS, creators: [...OPTIONS.creators, { id: 9001, name: '张三' }], producers: [...OPTIONS.producers, { id: 9002, name: '某某公司（供应商甲）' }] };
  const dir = materials({ 'GOFCN1004_成片.mp4': 'a' });
  const { materials: found, skipped } = await hashed([dir]);
  const plan = buildUploadPlan({ request: normalizeUploadRequest({ files: [dir], progress: true }), options: people, materials: found, skipped, existing: new Set(), progress: rows });
  assert.equal(plan.items[0].creator.name, '张三');
  assert.deepEqual(plan.items[0].producers, [{ id: 9002, name: '某某公司（供应商甲）' }]);
  assert.equal(plan.items[0].source.progress_row.row, 2);

  for (const [file, pattern] of [['GOFCN1001_x.mp4', /有 2 行/], ['GOFCN9999_x.mp4', /进度表里没有 GOFCN9999/], ['无编号.mp4', /没有 GOFCN 素材编号/]] as const) {
    const other = materials({ [file]: 'b' });
    const scanned = await hashed([other]);
    assert.throws(() => buildUploadPlan({ request: normalizeUploadRequest({ files: [other], progress: true }), options: people, ...scanned, existing: new Set(), progress: rows }), pattern);
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
    fs.writeFileSync(path.join(dir, 'request.json'), JSON.stringify({ files: [zip], creator: '张天伟', producers: ['丁杰'] }));
    const summary = await planUpload(online(fake), undefined, path.join(dir, 'request.json'), path.join(dir, 'plan.json'), deps);
    assert.deepEqual(summary.items.map((i: any) => [i.name, i.type]).sort(), [['P01', '视频'], ['封面', '图片']]);
    assert.deepEqual(summary.skipped, [{ file: '新建文件夹.zip：新建文件夹/说明.txt', reason: 'CLS 不支持这种格式（.txt）' }]);
    const result = await runUpload(online(fake), summary.plan, deps);
    assert.equal(result.status, 'uploaded', JSON.stringify(result));
    assert.deepEqual(fake.requests.find(r => r.path === '/api/qcloud/signed-url')!.body!.files.sort(), ['P01/P01.mp4', '封面/封面.png']);
  } finally { fake.close(); }
});
