import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { draftIdOf } from '../src/gof/cls-adapter.ts';
import { checkPin, pinState } from '../src/gof/cls-guard.ts';
import { accountNames, checkToken } from '../src/gof/cls-session.ts';
import { Blocked, writeJsonNew } from '../src/gof/util.ts';
import { tempDir } from './helpers/tmp.ts';

test('an unreadable account pin is a refusal, never "no pin yet"', () => {
  const dir = tempDir('ra-pin-');
  const file = path.join(dir, 'account.json');
  assert.deepEqual(pinState(file), { state: 'none' });
  for (const text of ['', '{"id":', '{"id":"7"}', 'null']) {
    fs.writeFileSync(file, text);
    assert.equal(pinState(file).state, 'corrupt', text);
    assert.throws(() => checkPin(file, { id: 7, name: '张三' }), (error: Error) => error instanceof Blocked && /损坏/.test(error.message), text);
    assert.equal(fs.readFileSync(file, 'utf8'), text, 'the file is left for an administrator');
  }
  fs.writeFileSync(file, '{"id":7,"name":"张三","pinned_at":"x"}');
  assert.equal(pinState(file).state, 'ok');
  checkPin(file, { id: 7, name: '张三' });
});

test('the CLS server saying no is told apart from not being able to ask', async () => {
  const answer = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  const good = { code: 0, data: { id: 7, name: '张三', status: 1 } };
  assert.deepEqual(await checkToken('http://x', 'Bearer a', answer(200, good)), { account: { id: 7, name: '张三' } });
  assert.deepEqual(await checkToken('http://x', 'Bearer a', answer(401, { code: 401 })), { rejected: true });
  assert.deepEqual(await checkToken('http://x', 'Bearer a', answer(200, { code: 0, data: { id: 7, status: 0 } })), { rejected: true });
  assert.deepEqual(await checkToken('http://x', 'Bearer a', answer(200, null)), { rejected: true });
  for (const status of [502, 503, 429]) assert.deepEqual(await checkToken('http://x', 'Bearer a', answer(status, {})), { unreachable: true }, String(status));
  assert.deepEqual(await checkToken('http://x', 'Bearer a', (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch), { unreachable: true });
});

test('the consent page may show the company name or one part of "name（alias）"', () => {
  assert.deepEqual(accountNames('张三'), ['张三']);
  assert.deepEqual(accountNames('张三（Zhang San）').sort(), ['Zhang San', '张三', '张三（Zhang San）'].sort());
  assert.deepEqual(accountNames('A'), [], 'one character would match anything');
});

test('a save response gives its draft ID as a number or digits, at the top or under script; anything else is not an ID', () => {
  assert.equal(draftIdOf({ id: 12 }), 12);
  assert.equal(draftIdOf({ id: '12' }), 12);
  assert.equal(draftIdOf({ script: { id: 5 } }), 5);
  for (const bad of [undefined, null, {}, { id: 0 }, { id: -1 }, { id: '1e3' }, { id: 1.5 }, { id: 'x' }]) assert.equal(draftIdOf(bad), undefined, JSON.stringify(bad));
});

test('files are created exclusively and never half-made', () => {
  const dir = tempDir('ra-new-');
  const file = path.join(dir, 'a.json');
  writeJsonNew(file, { a: 1 });
  assert.throws(() => writeJsonNew(file, { a: 2 }), /EEXIST/);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { a: 1 });
  assert.deepEqual(fs.readdirSync(dir), ['a.json'], 'no side file is left, after success or after a refusal');
});
