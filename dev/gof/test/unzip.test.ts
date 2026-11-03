import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { materialRefusal } from '../src/gof/creative.ts';
import { extractEntry, listZip, unpackZip } from '../src/gof/unzip.ts';
import { makeZip } from './helpers/zip-writer.ts';
import { tempDir } from './helpers/tmp.ts';

function zipFile(name: string, data: Buffer): string {
  const file = path.join(tempDir('zip-'), name);
  fs.writeFileSync(file, data);
  return file;
}

test('a zipped folder unpacks to its files, flat; deeper folders, other formats and system junk are left out with the reason', async () => {
  const video = Buffer.alloc(300_000, 7);
  const file = zipFile('素材.zip', makeZip([
    { name: '新建文件夹/GOFCN66367_片头.mp4', data: video },
    { name: '新建文件夹/封面.png', data: 'png', store: true },
    { name: '新建文件夹/说明.txt', data: 'txt' },
    { name: '新建文件夹/子文件夹/c.mp4', data: 'c' },
    { name: '新建文件夹/.DS_Store', data: 'x' },
    { name: '__MACOSX/新建文件夹/._封面.png', data: 'x' },
  ]));
  const root = tempDir('unpacked-');
  const result = await unpackZip(file, root, materialRefusal);
  assert.deepEqual(fs.readdirSync(result.dir).sort(), ['GOFCN66367_片头.mp4', '封面.png']);
  assert.ok(fs.readFileSync(path.join(result.dir, 'GOFCN66367_片头.mp4')).equals(video), 'deflated data comes back exactly');
  assert.deepEqual(result.skipped.map(s => [s.file, s.reason]), [
    ['素材.zip：新建文件夹/说明.txt', 'CLS 不支持这种格式（.txt）'],
    ['素材.zip：新建文件夹/子文件夹/c.mp4', '压缩包里的子文件夹不读取（文件夹不可嵌套）'],
  ]);
  // The same zip again: the folder already unpacked is used as it is.
  const again = await unpackZip(file, root, materialRefusal);
  assert.equal(again.dir, result.dir);
  assert.deepEqual(again.skipped, result.skipped);
});

test('names written by Chinese Windows tools (GBK, no UTF-8 flag) and zip64 records are read', async () => {
  const gbk = Buffer.from('b2e2cad4cbd8b2c42e6d7034', 'hex'); // 测试素材.mp4
  const entries = await listZip(zipFile('gbk.zip', makeZip([{ name: gbk, data: 'v' }, { name: 'plain.png', data: 'p' }])));
  assert.deepEqual(entries.map(e => e.name), ['测试素材.mp4', 'plain.png']);
  const big = zipFile('z64.zip', makeZip([{ name: 'a.mp4', data: Buffer.alloc(5000, 1) }, { name: '图.jpg', data: 'j' }], { zip64: true }));
  const result = await unpackZip(big, tempDir('unpacked-'), materialRefusal);
  assert.deepEqual(fs.readdirSync(result.dir).sort(), ['a.mp4', '图.jpg']);
  assert.equal(fs.statSync(path.join(result.dir, 'a.mp4')).size, 5000);
});

test('a damaged entry is refused and nothing of it is left; unsafe paths are never written', async () => {
  const bad = zipFile('bad.zip', makeZip([{ name: 'a.mp4', data: 'abc', badCrc: true }]));
  const root = tempDir('unpacked-');
  await assert.rejects(unpackZip(bad, root, materialRefusal), /已损坏/);
  const [folder] = fs.readdirSync(root);
  assert.deepEqual(fs.readdirSync(path.join(root, folder!, 'files')), []);
  const evil = zipFile('evil.zip', makeZip([{ name: '../evil.mp4', data: 'x' }, { name: 'ok.mp4', data: 'y' }]));
  const out = tempDir('unpacked-');
  const result = await unpackZip(evil, out, materialRefusal);
  assert.deepEqual(fs.readdirSync(result.dir), ['ok.mp4']);
  assert.equal(result.skipped[0]!.reason, '路径不安全，没有解压');
  assert.equal(fs.existsSync(path.join(out, 'evil.mp4')), false);
  await assert.rejects(listZip(zipFile('not.zip', Buffer.from('not a zip'))), /不是有效的 zip/);
});

test('names a Windows file cannot hold are stored with _ and said so; two that come out the same are one file, not a failed zip', async () => {
  const file = zipFile('mac.zip', makeZip([
    { name: '素材/为什么?_竖版.mp4', data: 'one' }, { name: '素材/为什么*_竖版.mp4', data: 'two' },
    { name: '素材/对抗:竖版.mp4', data: 'three' }, { name: '素材/ok.mp4', data: 'four' },
  ]));
  const root = tempDir('unpacked-');
  const result = await unpackZip(file, root, materialRefusal);
  assert.deepEqual(fs.readdirSync(result.dir).sort(), ['ok.mp4', '为什么__竖版.mp4', '对抗_竖版.mp4'].sort());
  assert.equal(fs.readFileSync(path.join(result.dir, '为什么__竖版.mp4'), 'utf8'), 'one', 'the first of the two is kept');
  assert.deepEqual(result.renamed, [{ file: 'mac.zip：素材/为什么?_竖版.mp4', as: '为什么__竖版.mp4' }, { file: 'mac.zip：素材/对抗:竖版.mp4', as: '对抗_竖版.mp4' }]);
  assert.deepEqual(result.skipped.map(s => s.file), ['mac.zip：素材/为什么*_竖版.mp4']);
  assert.match(result.skipped[0]!.reason, /和“为什么\?_竖版\.mp4”换掉 Windows 文件名不能有的字符后同名/);
  assert.deepEqual((await unpackZip(file, root, materialRefusal)).renamed, result.renamed, 'said again when the unpacked folder is used again');
});

test('an entry that cannot be written leaves a file of that name that was there already', async () => {
  const file = zipFile('one.zip', makeZip([{ name: 'a.mp4', data: 'new' }]));
  const [entry] = await listZip(file);
  const target = path.join(tempDir('target-'), 'a.mp4');
  fs.writeFileSync(target, 'already here');
  await assert.rejects(extractEntry(file, entry!, target), /解压失败/);
  assert.equal(fs.readFileSync(target, 'utf8'), 'already here');
});
