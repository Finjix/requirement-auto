import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepare, record } from '../src/gof/batch.ts';
import { main } from '../src/gof/cli.ts';
import type { Online } from '../src/gof/cls-online.ts';
import type { Capture } from '../src/gof/cls-session.ts';
import { makePlan } from '../src/gof/plan.ts';
import { Snapshot } from '../src/gof/snapshot.ts';
import { readJson } from '../src/gof/util.ts';
import { fakeCls } from './helpers/fake-cls.ts';
import { tempDir } from './helpers/tmp.ts';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const catalog = readJson(path.join(fixtures, 'catalog.json'));
const request = readJson(path.join(fixtures, 'requests', 'basic.json'));

type Obj = Record<string, any>;

async function readyBatch(): Promise<string> {
  const base = new Snapshot(path.join(fixtures, 'base.xlsx'));
  const dir = prepare(makePlan(base, request), base, { outputRoot: tempDir('cls-online-') }).batch as string;
  record(dir, 'append_started', null);
  record(dir, 'append_verified', null, {}, new Snapshot(path.join(fixtures, 'applied-complete.xlsx')));
  record(dir, 'cls_started', '01');
  return dir;
}

const sessionOf = (origin: string, authorization = 'Bearer good'): Online => ({
  session: async () => ({ authorization, account: { id: 7, name: '张三' }, origin }),
  capture: async () => ({ state: 'login_required' }),
});

const write = (dir: string, name: string, value: unknown): string => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
};

async function ok(args: string[], via: Online): Promise<Obj> {
  const { result, code } = await main(args, undefined, via);
  assert.equal(code, 0, JSON.stringify(result));
  return result;
}

test('a whole group goes through the commands: options, observations, draft, import, and each receipt is accepted by the batch', async () => {
  const cls = await fakeCls(catalog);
  try {
    const dir = await readyBatch();
    const via = sessionOf(cls.origin);
    const live = path.join(dir, 'live-catalog.json');
    const saved = await ok(['cls', 'catalog', '--output', live], via);
    assert.deepEqual([saved.status, saved.can_create, saved.can_import], ['catalog_saved', true, true]);
    const { observed_at: _seen, ...rest } = readJson(live);
    assert.deepEqual(rest, catalog, 'what the adapter reads from the API is the catalog the operations are built from');

    // 1. the draft
    const observations = path.join(dir, 'obs-save.json');
    await ok(['cls', 'observe', '--action', 'save_draft', '--output', observations], via);
    const save = path.join(dir, 'save-operation.json');
    const built = await ok(['cls', '--batch', dir, '--group', '01', '--action', 'save_draft', '--catalog', live, '--observations', observations, '--output', save], via);
    const attempt = write(dir, 'attempt-save.json', { action: 'save_draft', operation_id: built.operation_id, observations: readJson(observations) });
    await ok(['batch', 'record', '--batch', dir, '--step', 'cls_api_attempt', '--group', '01', '--evidence', attempt], via);
    const receipt = path.join(dir, 'receipt-save.json');
    const sent = await ok(['cls', 'run', '--batch', dir, '--operation', save, '--output', receipt], via);
    assert.deepEqual([sent.status, sent.draft_id, sent.requirement_number], ['receipt_saved', 5001, 'GOFCN20260100009']);
    assert.equal(sent.url, `${cls.origin}/requirement/5001/edit-outer`);
    // The origin of the fake is not CLS's, so the batch refuses the URL that the real command would have produced for it: check the real shape.
    const draftEvidence = write(dir, 'draft-evidence.json', { confirmed: true, unpublished: true, transport: 'cls_api', draft_id: 5001, operation: save, receipt,
      url: 'https://creative.centurygames.cn/requirement/5001/edit-outer', requirement_number: 'GOFCN20260100009' });
    await ok(['batch', 'record', '--batch', dir, '--step', 'draft_saved', '--group', '01', '--evidence', draftEvidence], via);

    // 2. the import into that draft
    const obsImport = path.join(dir, 'obs-import.json');
    const seen = await ok(['cls', 'observe', '--action', 'import_scripts', '--draft', '5001', '--output', obsImport], via);
    assert.deepEqual([seen.import_enabled, seen.import_would_publish, seen.unpublished], [true, false, true]);
    const imp = path.join(dir, 'import-operation.json');
    const builtImport = await ok(['cls', '--batch', dir, '--group', '01', '--action', 'import_scripts', '--catalog', live, '--observations', obsImport, '--output', imp], via);
    const attemptImport = write(dir, 'attempt-import.json', { action: 'import_scripts', operation_id: builtImport.operation_id, observations: readJson(obsImport) });
    await ok(['batch', 'record', '--batch', dir, '--step', 'cls_api_attempt', '--group', '01', '--evidence', attemptImport], via);
    const receiptImport = path.join(dir, 'receipt-import.json');
    const imported = await ok(['cls', 'run', '--batch', dir, '--operation', imp, '--output', receiptImport], via);
    assert.equal(imported.scripts, 2);
    const names = readJson(imp).expected.names;
    const importEvidence = write(dir, 'import-evidence.json', { confirmed: true, unpublished: true, transport: 'cls_api', draft_id: 5001, operation: imp, receipt: receiptImport,
      url: 'https://creative.centurygames.cn/requirement/5001/edit-outer', quantity: 2, names });
    await ok(['batch', 'record', '--batch', dir, '--step', 'scripts_imported', '--group', '01', '--evidence', importEvidence], via);

    // Only Authorization was sent, only to the allowed paths, and nothing was ever published or deleted.
    assert.ok(cls.requests.every(r => r.authorization === 'Bearer good'));
    const writes = cls.requests.filter(r => r.method !== 'GET').map(r => r.path);
    assert.deepEqual(writes, ['/api/workflow/script/save', '/api/workflow/sub-script/multiple-add']);
    assert.equal(cls.drafts.get(5001)!.status, -2);
  } finally { cls.close(); }
});

test('a write needs its recorded attempt, goes out once, and the same operation is refused the second time', async () => {
  const cls = await fakeCls(catalog);
  try {
    const dir = await readyBatch();
    const via = sessionOf(cls.origin);
    const live = path.join(dir, 'live-catalog.json');
    await ok(['cls', 'catalog', '--output', live], via);
    const observations = path.join(dir, 'obs.json');
    await ok(['cls', 'observe', '--action', 'save_draft', '--output', observations], via);
    const save = path.join(dir, 'save-operation.json');
    const built = await ok(['cls', '--batch', dir, '--group', '01', '--action', 'save_draft', '--catalog', live, '--observations', observations, '--output', save], via);

    const early = await main(['cls', 'run', '--batch', dir, '--operation', save, '--output', path.join(dir, 'r1.json')], undefined, via);
    assert.match(early.result.reason, /cls_api_attempt/);
    assert.equal(cls.requests.filter(r => r.method === 'POST').length, 0);

    const attempt = write(dir, 'attempt.json', { action: 'save_draft', operation_id: built.operation_id, observations: readJson(observations) });
    await ok(['batch', 'record', '--batch', dir, '--step', 'cls_api_attempt', '--group', '01', '--evidence', attempt], via);
    await ok(['cls', 'run', '--batch', dir, '--operation', save, '--output', path.join(dir, 'r1.json')], via);
    const again = await main(['cls', 'run', '--batch', dir, '--operation', save, '--output', path.join(dir, 'r2.json')], undefined, via);
    assert.equal(again.code, 2);
    assert.match(again.result.reason, /已经发出过写请求/);
    assert.equal(cls.requests.filter(r => r.method === 'POST').length, 1);

    // A different account than the one the operation was built for is refused before anything is sent.
    const other: Online = { session: async () => ({ authorization: 'Bearer good', account: { id: 99, name: '别人' }, origin: cls.origin }), capture: via.capture };
    const wrong = await main(['cls', 'run', '--batch', dir, '--operation', save, '--output', path.join(dir, 'r3.json')], undefined, other);
    assert.match(wrong.result.reason, /不是同一个/);
  } finally { cls.close(); }
});

test('a write that gets no answer is reported as unknown with what is needed to read it back, and cannot be sent again', async () => {
  const cls = await fakeCls(catalog);
  try {
    const dir = await readyBatch();
    const via = sessionOf(cls.origin);
    const live = path.join(dir, 'live-catalog.json');
    await ok(['cls', 'catalog', '--output', live], via);
    const observations = path.join(dir, 'obs.json');
    await ok(['cls', 'observe', '--action', 'save_draft', '--output', observations], via);
    const save = path.join(dir, 'save-operation.json');
    const built = await ok(['cls', '--batch', dir, '--group', '01', '--action', 'save_draft', '--catalog', live, '--observations', observations, '--output', save], via);
    const attempt = write(dir, 'attempt.json', { action: 'save_draft', operation_id: built.operation_id, observations: readJson(observations) });
    await ok(['batch', 'record', '--batch', dir, '--step', 'cls_api_attempt', '--group', '01', '--evidence', attempt], via);

    cls.postMode = 'hang-up';
    const lost = await main(['cls', 'run', '--batch', dir, '--operation', save, '--output', path.join(dir, 'r1.json')], undefined, via);
    assert.equal(lost.code, 2);
    assert.deepEqual([lost.result.unknown_result, lost.result.operation_id], [true, built.operation_id]);
    assert.ok(!fs.existsSync(path.join(dir, 'r1.json')));
    cls.postMode = 'normal';
    const retry = await main(['cls', 'run', '--batch', dir, '--operation', save, '--output', path.join(dir, 'r2.json')], undefined, via);
    assert.match(retry.result.reason, /已经发出过写请求/);
    assert.equal(cls.requests.filter(r => r.method === 'POST').length, 1, 'the second run never reached the server');
  } finally { cls.close(); }
});

test('a draft that exists is read back and verified without any write', async () => {
  const cls = await fakeCls(catalog);
  try {
    const dir = await readyBatch();
    const via = sessionOf(cls.origin);
    const live = path.join(dir, 'live-catalog.json');
    await ok(['cls', 'catalog', '--output', live], via);
    const observations = path.join(dir, 'obs.json');
    await ok(['cls', 'observe', '--action', 'save_draft', '--output', observations], via);
    const save = path.join(dir, 'save-operation.json');
    const built = await ok(['cls', '--batch', dir, '--group', '01', '--action', 'save_draft', '--catalog', live, '--observations', observations, '--output', save], via);
    const attempt = write(dir, 'attempt.json', { action: 'save_draft', operation_id: built.operation_id, observations: readJson(observations) });
    await ok(['batch', 'record', '--batch', dir, '--step', 'cls_api_attempt', '--group', '01', '--evidence', attempt], via);
    await ok(['cls', 'run', '--batch', dir, '--operation', save, '--output', path.join(dir, 'r1.json')], via);

    const before = cls.requests.filter(r => r.method === 'POST').length;
    const draft = await ok(['cls', 'read-draft', '--id', '5001'], via);
    assert.equal(draft.draft.status, -2);
    const verified = await ok(['cls', 'verify', '--batch', dir, '--operation', save, '--draft', '5001', '--output', path.join(dir, 'r-verify.json')], via);
    assert.equal(verified.status, 'receipt_saved');
    assert.equal(cls.requests.filter(r => r.method === 'POST').length, before);
    assert.deepEqual(readJson(path.join(dir, 'r-verify.json')).calls.map((c: Obj) => `${c.method} ${c.path}`), ['GET /api/workflow/script/5001']);
    assert.equal((await main(['cls', 'read-draft', '--id', 'abc'], undefined, via)).code, 2);
  } finally { cls.close(); }
});

test('without a login every online command stops with the instruction to log in, and nothing is sent', async () => {
  const cls = await fakeCls(catalog);
  try {
    const loggedOut: Online = {
      session: async () => { throw new (await import('../src/gof/util.ts')).Blocked('CLS 未登录或登录已过期：先运行 gof.mjs cls login，请用户在弹出的浏览器窗口里完成公司登录'); },
      capture: async () => ({ state: 'login_required' }),
    };
    for (const args of [['cls', 'session'], ['cls', 'read-draft', '--id', '1'], ['cls', 'catalog', '--output', path.join(tempDir('cls-none-'), 'c.json')]]) {
      const { result, code } = await main(args, undefined, loggedOut);
      assert.equal(code, 2);
      assert.match(result.reason, /cls login/);
    }
    assert.equal(cls.requests.length, 0);
  } finally { cls.close(); }
});

test('cls login: picks up a login that is already there without a window, otherwise opens one and waits for the person', async () => {
  const seen: [boolean, number][] = [];
  const script = (...states: Capture[]): Online => ({
    session: async () => { throw new Error('not used'); },
    capture: async (headed, waitMs) => { seen.push([headed, waitMs]); return states.shift()!; },
  });
  const account = { id: 7, name: '张三' };
  const here = await main(['cls', 'login'], undefined, script({ state: 'ok', authorization: 'x', account }));
  assert.deepEqual([here.result.status, here.result.window, seen], ['logged_in', 'not_needed', [[false, 12_000]]]);

  seen.length = 0;
  const shown = await main(['cls', 'login', '--wait', '30'], undefined, script({ state: 'login_required' }, { state: 'ok', authorization: 'x', account }));
  assert.deepEqual([shown.result.status, shown.result.window, seen], ['logged_in', 'closed', [[false, 12_000], [true, 30_000]]]);

  const waiting = await main(['cls', 'login'], undefined, script({ state: 'login_required' }, { state: 'waiting' }));
  assert.deepEqual([waiting.code, waiting.result.status], [0, 'waiting']);
  assert.match(waiting.result.message, /窗口/);

  const closed = await main(['cls', 'login'], undefined, script({ state: 'login_required' }, { state: 'closed' }));
  assert.equal(closed.code, 2);
  assert.equal((await main(['cls', 'login', '--wait', '1'], undefined, script())).code, 2);
  const text = JSON.stringify([here, shown, waiting, closed]);
  assert.ok(!text.includes('authorization') && !/Bearer|"x"/.test(text), 'the token is never in what a command prints');
});
