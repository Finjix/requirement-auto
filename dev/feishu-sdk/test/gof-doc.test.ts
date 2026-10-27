import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BRIDGE_VERSION, type BridgeReply } from '../src/bridge.ts';
import { editDoc, outline } from '../src/gof/doc.ts';
import { Bridge } from '../src/gof/feishu.ts';
import { NODE } from '../src/gof/util.ts';
import { main } from '../src/gof/cli.ts';

type Obj = Record<string, any>;
const URL_ = 'https://centurygames.feishu.cn/wiki/DocNode123456';
const SHEET_URL = 'https://centurygames.feishu.cn/sheets/ReqSheet123456?sheet=t1';
const ok = (data: unknown): BridgeReply => ({ ok: true, data });
const fail = (kind: string, message: string, code?: number): BridgeReply => ({ ok: false, error: { kind: kind as any, message, ...(code ? { code } : {}) } });
const text = (id: string, content: string, parent: string, type = 2) => ({ block_id: id, block_type: type, parent_id: parent,
  [{ 2: 'text', 3: 'heading1' }[type]!]: { elements: [{ text_run: { content } }], style: {} } });

/** A docx as Feishu keeps it: blocks by ID, the page's children in order, a revision that moves with every edit. */
class FakeDoc {
  blocks = new Map<string, Obj>();
  revision = 10;
  private n = 0;
  constructor() {
    this.blocks.set('PageBlock0001', { block_id: 'PageBlock0001', block_type: 1, children: [], page: { elements: [{ text_run: { content: '达治-GOFCN-需求表' } }] } });
    this.add(text('HeadOld000001', '1023——AI片头衔接需求', 'PageBlock0001', 3));
    this.table([['命名', '方向'], ['GOFCN1_a', ''], ['GOFCN2_b', '已有']], [{ row_span: 1, col_span: 1 }, { row_span: 1, col_span: 1 }, { row_span: 1, col_span: 1 },
      { row_span: 2, col_span: 1 }, { row_span: 1, col_span: 1 }, { row_span: 1, col_span: 1 }]);
  }
  id(): string { return `Real${String(++this.n).padStart(9, '0')}`; }
  get page() { return this.blocks.get('PageBlock0001')!; }
  add(block: Obj, index = this.page.children.length) { this.blocks.set(block.block_id, block); this.page.children.splice(index, 0, block.block_id); }
  table(rows: string[][], merge?: Obj[]) {
    const id = this.id();
    const cells = rows.flat().map(content => {
      const cell = this.id();
      const t = this.id();
      this.blocks.set(t, text(t, content, cell));
      this.blocks.set(cell, { block_id: cell, block_type: 32, parent_id: id, children: [t], table_cell: {} });
      return cell;
    });
    this.add({ block_id: id, block_type: 31, parent_id: 'PageBlock0001', children: cells,
      table: { cells, property: { row_size: rows.length, column_size: rows[0]!.length, ...(merge ? { merge_info: merge } : {}) } } });
  }
  insert(p: Obj): Obj {
    const real = new Map<string, string>(p.descendants.map((d: Obj) => [d.block_id, this.id()]));
    for (const d of p.descendants as Obj[]) {
      const block: Obj = { ...structuredClone(d), block_id: real.get(d.block_id), children: (d.children ?? []).map((c: string) => real.get(c)) };
      if (block.block_type === 31) block.table.cells = block.children;
      this.blocks.set(block.block_id, block);
    }
    this.page.children.splice(p.index, 0, ...p.children_id.map((c: string) => real.get(c)));
    this.revision++;
    return { children: [], block_id_relations: [...real].map(([temporary_block_id, block_id]) => ({ temporary_block_id, block_id })) };
  }
  setTexts(p: Obj): Obj {
    for (const u of p.updates as Obj[]) this.blocks.get(u.block_id)!.text.elements = u.elements;
    this.revision++;
    return {};
  }
}

function harness(over: Partial<{ scopes: string[]; insert: (p: Obj) => BridgeReply }> = {}) {
  const doc = new FakeDoc();
  const sheet: Record<string, string> = { A2: 'GOFCN9_x' };
  const calls: { name: string; payload: any }[] = [];
  const scopes = over.scopes ?? ['docx:document'];
  const bridge = new Bridge(async (name, payload: any) => {
    calls.push({ name, payload });
    switch (name) {
      case 'info': return ok({ bridge: BRIDGE_VERSION, node: 'v24', app_configured: true });
      case 'auth-status': return ok({ logged_in: true, name: '测试', open_id: 'ou_x' });
      case 'auth-check-scopes': {
        const missing = (payload.required as string[]).filter(s => !scopes.includes(s) && !s.startsWith('sheets') && !s.startsWith('wiki') && !s.startsWith('drive') && s !== 'docx:document:readonly');
        return ok({ complete: missing.length === 0, granted: payload.required.filter((s: string) => !missing.includes(s)), missing });
      }
      case 'api-get': {
        if (payload.path === '/open-apis/wiki/v2/spaces/get_node') {
          return payload.params.token === NODE ? ok({ node: { node_token: NODE, obj_type: 'sheet', obj_token: 'ProgressSheet1' } })
            : ok({ node: { obj_type: 'docx', obj_token: 'DocToken12345', title: '达治-GOFCN-需求表', parent_node_token: '' } });
        }
        if (payload.path.endsWith('/sheets/query')) return ok({ sheets: [{ sheet_id: 't1', title: '1027', index: 0, resource_type: 'sheet' }] });
        if (payload.path.endsWith('/values_batch_get')) {
          return ok({ valueRanges: String(payload.params.ranges).split(',').map(r => ({ range: r, values: [[sheet[r.split('!')[1]!.split(':')[0]!] ?? null]] })) });
        }
        return fail('invalid_request', `unexpected ${payload.path}`);
      }
      case 'docx-blocks': return ok({ revision: doc.revision, title: '达治-GOFCN-需求表', blocks: [...doc.blocks.values()].map(b => structuredClone(b)) });
      case 'docx-insert': return over.insert ? over.insert(payload) : ok(doc.insert(payload));
      case 'docx-set-texts': return ok(doc.setTexts(payload));
      case 'sheets-cells-set': {
        for (const w of payload.writes) {
          const cell = w.range.split(':')[0];
          if (w.allow_overwrite !== false || sheet[cell]) return fail('occupied', 'non-empty');
        }
        for (const w of payload.writes) sheet[w.range.split(':')[0]] = w.cells[0][0].value;
        return ok({});
      }
      default: return fail('invalid_request', `unexpected ${name}`);
    }
  });
  return { doc, sheet, calls, bridge, writes: () => calls.filter(c => ['docx-insert', 'docx-set-texts', 'sheets-cells-set'].includes(c.name)) };
}

const entry = { insert: { at: { before: 0, expect: '1023——AI片头衔接需求' }, blocks: [
  { heading1: '1027-AI片头需求' }, { text: '需求数量：2条' }, { table: [['命名', '方向'], ['GOFCN67867_巨手', '巨手'], ['GOFCN67868_巨手', '']] }] } };

test('the outline shows the top level, a table by its first rows, a merged cell as null, and one block whole', async () => {
  const { bridge, doc } = harness();
  doc.table([['h'], ['1'], ['2'], ['3'], ['4'], ['5']]);
  const all = await outline(bridge, URL_);
  assert.equal(all.title, '达治-GOFCN-需求表');
  assert.deepEqual(all.blocks.slice(0, 2), [{ index: 0, type: 'heading1', text: '1023——AI片头衔接需求' },
    { index: 1, type: 'table', text: '命名 | 方向', rows: 3, cols: 2, cells: [['命名', '方向'], ['GOFCN1_a', ''], ['GOFCN2_b', null]] }]);
  assert.deepEqual([all.blocks[2].cells.length, all.blocks[2].more_rows], [4, 2]);
  const one = await outline(bridge, URL_, { block: 2 });
  assert.deepEqual([one.blocks.length, one.blocks[0].cells.length], [1, 6]);
});

test('new blocks go in where the outline showed, are read back, and an edit run twice writes once', async () => {
  const { bridge, doc, writes } = harness();
  const check = await editDoc(bridge, URL_, entry, true);
  assert.deepEqual([check.status, check.index, check.preview], ['edit_ready', 0, ['heading1: 1027-AI片头需求', 'text: 需求数量：2条', 'table: 命名 | 方向']]);
  assert.equal(writes().length, 0);
  const done = await editDoc(bridge, URL_, entry);
  assert.deepEqual([done.status, done.index], ['doc_updated', 0]);
  const sent = writes()[0]!.payload;
  assert.equal(sent.parent, 'PageBlock0001');
  assert.equal(sent.descendants.filter((d: Obj) => d.block_type === 32).length, 6);
  assert.match(sent.client_token, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
  const after = await outline(bridge, URL_, { full: true });
  assert.deepEqual(after.blocks.map((b: Obj) => b.text), ['1027-AI片头需求', '需求数量：2条', '命名 | 方向', '1023——AI片头衔接需求', '命名 | 方向']);
  assert.deepEqual(after.blocks[2].cells, [['命名', '方向'], ['GOFCN67867_巨手', '巨手'], ['GOFCN67868_巨手', '']]);
  // The anchor has moved down by the three new blocks: it is found by its text, and the blocks are there already.
  const again = await editDoc(bridge, URL_, entry);
  assert.deepEqual([again.status, writes().length], ['already_present', 1]);
  // At the end, and after a block.
  assert.equal((await editDoc(bridge, URL_, { insert: { at: 'end', blocks: [{ divider: true }, { bullet: [{ text: '链接', link: 'https://a.b/c?d=1' }] }] } })).status, 'doc_updated');
  const link = [...doc.blocks.values()].find(b => b.block_type === 12)!.bullet.elements[0].text_run.text_element_style.link.url;
  assert.equal(link, encodeURIComponent('https://a.b/c?d=1'));
  assert.equal((await editDoc(bridge, URL_, { insert: { at: { after: 0, expect: '1027-AI片头需求' }, blocks: [{ heading2: '补充' }] } })).index, 1);
});

test('an edit whose place is gone, or that cannot be checked, writes nothing', async () => {
  const { bridge, writes } = harness();
  await assert.rejects(editDoc(bridge, URL_, { insert: { at: { before: 0, expect: '别的标题' }, blocks: [{ text: 'x' }] } }), /找不到它；重新读大纲再定位置/);
  await assert.rejects(editDoc(bridge, URL_, { insert: { at: { before: 1, expect: '命名 | 方向' }, blocks: [{ table: [['a', 'b'], ['c']] }] } }), /每行同样多个/);
  await assert.rejects(editDoc(bridge, URL_, { insert: { at: 'start', blocks: [{ image: 'x' }] } }), /类型“image”不支持/);
  await assert.rejects(editDoc(bridge, URL_, { insert: { at: 'start', blocks: [{ text: 'x', bold: true }] } }), /只能有一个类型/);
  await assert.rejects(editDoc(bridge, URL_, { replace: {} }), /insert.*fill/);
  assert.equal(writes().length, 0);
  // A login from before document editing: the user authorizes once more; the check itself still runs.
  const old = harness({ scopes: [] });
  assert.equal((await editDoc(old.bridge, URL_, entry, true)).status, 'edit_ready');
  await assert.rejects(editDoc(old.bridge, URL_, entry), /重新扫码授权一次/);
  assert.equal(old.writes().length, 0);
});

test('Feishu refusing the edit is said plainly, and a write whose answer is lost is read back by running it again', async () => {
  const denied = harness({ insert: () => fail('api', '飞书接口返回错误（HTTP 403）：forbidden', 1770032) });
  await assert.rejects(editDoc(denied.bridge, URL_, entry), /没有这份文档的编辑权限/);
  let lost = true;
  const flaky = harness({ insert: p => { const reply = flaky.doc.insert(p); if (lost) { lost = false; return fail('unknown_result', 'timeout'); } return ok(reply); } });
  await assert.rejects(editDoc(flaky.bridge, URL_, entry), /再运行一次同样的 doc-edit/);
  assert.equal((await editDoc(flaky.bridge, URL_, entry)).status, 'already_present');
  // A read-back that does not show what was planned is reported, not retried.
  const odd = harness({ insert: p => ok(odd.doc.insert({ ...p, descendants: p.descendants.map((d: Obj) => (d.block_type === 3 ? { ...d, heading1: { elements: [{ text_run: { content: '别的' } }] } } : d)) })) });
  await assert.rejects(editDoc(odd.bridge, URL_, entry), /回读与计划不符/);
});

test('table cells are filled only where empty, never under a merge, and filling again changes nothing', async () => {
  const { bridge, writes } = harness();
  const fill = (cells: Obj[]) => ({ fill: { table: 1, expect: '命名 | 方向', cells } });
  await assert.rejects(editDoc(bridge, URL_, fill([{ row: 2, col: 0, text: 'x' }])), /已有内容“GOFCN2_b”，不覆盖/);
  await assert.rejects(editDoc(bridge, URL_, fill([{ row: 2, col: 1, text: 'x' }])), /被合并在别的单元格下/);
  await assert.rejects(editDoc(bridge, URL_, fill([{ row: 3, col: 0, text: 'x' }])), /不在 3×2 的表格里/);
  assert.equal(writes().length, 0);
  const done = await editDoc(bridge, URL_, fill([{ row: 1, col: 1, text: '巨手' }, { row: 0, col: 0, text: '命名' }]));
  assert.deepEqual([done.status, done.to_write, done.already], ['doc_updated', 1, 1]);
  assert.equal((await outline(bridge, URL_)).blocks[1].cells[1][1], '巨手');
  assert.equal((await editDoc(bridge, URL_, fill([{ row: 1, col: 1, text: '巨手' }]))).status, 'already_present');
  assert.equal(writes().length, 1);
});

test('a sheet gets text in empty cells only, written so that Feishu refuses an occupied one; the progress sheet is not edited here', async () => {
  const { bridge, sheet, writes } = harness();
  await assert.rejects(editDoc(bridge, SHEET_URL, { fill: { cells: [{ cell: 'A2', text: 'GOFCN1_y' }] } }), /A2 已有内容“GOFCN9_x”，不覆盖/);
  await assert.rejects(editDoc(bridge, SHEET_URL, { fill: { cells: [{ cell: 'B2', text: '=SUM(1)' }] } }), /不能以 = 开头/);
  const done = await editDoc(bridge, SHEET_URL, { fill: { cells: [{ cell: 'b3', text: 'GOFCN67867_巨手' }, { cell: 'A2', text: 'GOFCN9_x' }] } });
  assert.deepEqual([done.status, done.sheet, done.to_write, sheet.B3], ['doc_updated', '1027', 1, 'GOFCN67867_巨手']);
  assert.ok(writes()[0]!.payload.writes.every((w: Obj) => w.allow_overwrite === false));
  await assert.rejects(editDoc(bridge, `https://centurygames.feishu.cn/wiki/${NODE}`, { fill: { sheet: 'x', cells: [{ cell: 'A1', text: 'x' }] } }), /创意进度表只能用 gof feishu append/);
  await assert.rejects(editDoc(bridge, SHEET_URL, { insert: { at: 'start', blocks: [{ text: 'x' }] } }), /这是表格/);
});

test('the command line reads an outline and runs an edit file', async () => {
  const { bridge } = harness();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gof-doc-'));
  const file = path.join(dir, 'edit.json');
  fs.writeFileSync(file, JSON.stringify(entry));
  const checked = await main(['feishu', 'doc-edit', '--url', URL_, '--edit', file, '--check'], bridge);
  assert.deepEqual([checked.code, checked.result.status], [0, 'edit_ready']);
  const shown = await main(['feishu', 'document', '--url', URL_, '--outline'], bridge);
  assert.deepEqual([shown.code, shown.result.blocks.length], [0, 2]);
  const bad = await main(['feishu', 'document', '--url', URL_, '--block', 'x'], bridge);
  assert.equal(bad.code, 2);
});
