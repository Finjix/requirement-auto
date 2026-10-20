import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { main } from '../src/gof/cli.ts';
import { checkPin, guardOnline, readPin, writeQr } from '../src/gof/cls-guard.ts';
import type { Online } from '../src/gof/cls-online.ts';
import { clsAccountFile, clsProfileDir, type Capture } from '../src/gof/cls-session.ts';
import { BridgeError } from '../src/errors.ts';
import { resolveDataPaths } from '../src/paths.ts';
import { tempDir } from './helpers/tmp.ts';

const alice = { id: 7, name: '张三' };
const bob = { id: 8, name: '李四' };
const ok = (account: { id: number; name: string }): Capture => ({ state: 'ok', authorization: 'secret-token-1', account });

/** What a hidden browser would give back, one scripted answer per call. */
function scripted(...answers: Capture[]): Online {
  return {
    session: async () => { const a = answers.shift()!; if (a.state !== 'ok') throw new Error('no login'); return { authorization: a.authorization, account: a.account, origin: 'https://cls.test' }; },
    capture: async () => answers.shift() ?? { state: 'login_required' },
  };
}

test('each user has their own CLS profile and account file under their own directory', () => {
  const a = tempDir('ra-cls-a-'), b = tempDir('ra-cls-b-');
  const envA = { LARK_AGENT_USER_DIR: a }, envB = { LARK_AGENT_USER_DIR: b };
  assert.equal(clsProfileDir(envA), path.join(a, 'requirement-auto', 'cls', 'browser-profile'));
  assert.equal(clsProfileDir(envB), path.join(b, 'requirement-auto', 'cls', 'browser-profile'));
  assert.equal(clsAccountFile(envA), path.join(a, 'requirement-auto', 'cls', 'account.json'));
  assert.notEqual(clsProfileDir(envA), clsProfileDir(envB));
  for (const [file, dir] of [[clsProfileDir(envA), a], [clsAccountFile(envA), a], [clsProfileDir(envB), b], [clsAccountFile(envB), b]] as const) {
    assert.ok(path.relative(dir, file) && !path.relative(dir, file).startsWith('..'), `${file} stays inside ${dir}`);
  }
});

test('a host that names the user but not the directory is refused instead of sharing one folder', () => {
  assert.throws(() => resolveDataPaths({ LARK_AGENT_USER_OPEN_ID: 'ou_alice' }, tempDir('ra-home-')), (e: BridgeError) => e.kind === 'config' && /LARK_AGENT_USER_DIR/.test(e.message));
  assert.throws(() => clsProfileDir({ LARK_AGENT_USER_OPEN_ID: 'ou_alice' }), (e: BridgeError) => e.kind === 'config');
  // The single-machine modes are unchanged.
  assert.equal(resolveDataPaths({ PLUGIN_DATA: tempDir('ra-pd-') }).mode, 'plugin-data');
  assert.equal(resolveDataPaths({}, tempDir('ra-home-')).mode, 'standalone');
  assert.equal(resolveDataPaths({ LARK_AGENT_USER_OPEN_ID: 'ou_alice', LARK_AGENT_USER_DIR: tempDir('ra-u-') }).mode, 'host');
});

test('the first CLS account is pinned, the same one passes, another is refused without naming it', () => {
  const file = path.join(tempDir('ra-pin-'), 'cls', 'account.json');
  assert.equal(readPin(file), undefined);
  checkPin(file, alice, () => new Date('2026-10-19T08:00:00Z'));
  assert.deepEqual(readPin(file), { id: 7, name: '张三', pinned_at: '2026-10-19T08:00:00.000Z' });
  checkPin(file, { id: 7, name: '张三（改名）' }); // the same account under a new display name
  assert.throws(() => checkPin(file, bob), (e: Error) => e.name === 'Blocked' && e.message.includes('张三') && !e.message.includes('李四') && /管理员/.test(e.message));
  assert.equal(readPin(file)?.id, 7, 'a refused login does not replace the pin');
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(!/authorization|token|secret/i.test(text), 'the pin holds id and name only');
});

test('through the commands: login pins, a different account is refused by login and by every later command', async () => {
  const dir = tempDir('ra-pin-cmd-');
  const pinFile = path.join(dir, 'account.json');
  const png = path.join(dir, 'cls-login.png');

  const first = await main(['cls', 'login', '--qr', png], undefined, guardOnline(scripted(ok(alice)), { pinFile }));
  assert.deepEqual([first.code, first.result.status, readPin(pinFile)?.id], [0, 'logged_in', 7]);

  const wrong = await main(['cls', 'login', '--qr', png], undefined, guardOnline(scripted(ok(bob)), { pinFile }));
  assert.equal(wrong.code, 2);
  assert.match(wrong.result.reason, /已绑定为“张三”/);

  const wrongSession = await main(['cls', 'session'], undefined, guardOnline(scripted(ok(bob)), { pinFile }));
  assert.equal(wrongSession.code, 2);

  const rightSession = await main(['cls', 'session'], undefined, guardOnline(scripted(ok(alice)), { pinFile }));
  assert.equal(rightSession.code, 0);
  const text = JSON.stringify([first, wrong, wrongSession, rightSession]);
  assert.ok(!text.includes('secret-token-1') && !text.includes('李四'), 'neither the token nor the other account is printed');
});

test('there is no login by window: cls login without --qr is refused and nothing is opened', async () => {
  let looked = 0;
  const online: Online = { session: async () => { throw new Error('not used'); }, capture: async () => { looked++; return { state: 'login_required' }; } };
  const result = await main(['cls', 'login'], undefined, online);
  assert.equal(result.code, 2);
  assert.match(result.result.reason, /--qr/);
  assert.equal(looked, 0);
  assert.equal((await main(['cls', 'login', '--wait', '30'], undefined, online)).code, 2);
});

const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

/** An Online whose QR step writes through the same functions the real one uses; `capture` answers come from the script. */
function qrOnline(dir: string, ...answers: Capture[]) {
  const recordFile = path.join(dir, 'login-qr.json');
  const outcome: { next: 'qr' | 'not_login_page'; calls: string[] } = { next: 'qr', calls: [] };
  const inner: Online = {
    session: async () => { throw new Error('not used'); },
    capture: async () => answers.shift() ?? { state: 'login_required' },
    loginQr: async file => {
      outcome.calls.push(file);
      return outcome.next === 'qr' ? { state: 'qr', file: writeQr(recordFile, file, PNG) } : { state: 'not_login_page', where: 'somewhere.test/page' };
    },
  };
  const guarded = (now?: () => Date) => guardOnline(inner, { pinFile: path.join(dir, 'account.json'), qrFile: recordFile, profileDir: path.join(dir, 'profile'), ...(now ? { now } : {}) });
  return { recordFile, outcome, guarded };
}

test('cls login --qr: a login that is still good needs no picture; otherwise the picture is written and described', async () => {
  const dir = tempDir('ra-qr-');
  const png = path.join(dir, 'workspace', 'cls-login.png');
  const t = qrOnline(dir, ok(alice));
  const here = await main(['cls', 'login', '--qr', png], undefined, t.guarded());
  assert.deepEqual([here.code, here.result.status, t.outcome.calls.length, fs.existsSync(png)], [0, 'logged_in', 0, false]);

  checkPin(path.join(dir, 'account.json'), alice);
  const made = await main(['cls', 'login', '--qr', png], undefined, t.guarded());
  assert.deepEqual([made.code, made.result.status, made.result.qr_file, made.result.expected_account], [0, 'qr_ready', path.resolve(png), '张三']);
  assert.match(made.result.message, /扫码/);
  assert.ok(fs.existsSync(png) && fs.existsSync(t.recordFile));
  assert.ok(!JSON.stringify(made).includes('secret-token'), 'no token anywhere in what is printed');
});

test('cls login --qr: asking again replaces the picture; another file or a non-picture name is refused', async () => {
  const dir = tempDir('ra-qr-more-');
  const png = path.join(dir, 'a.png');
  const t = qrOnline(dir);
  assert.equal((await main(['cls', 'login', '--qr', png], undefined, t.guarded())).result.status, 'qr_ready');
  fs.writeFileSync(png, 'older picture');
  assert.equal((await main(['cls', 'login', '--qr', png], undefined, t.guarded())).result.status, 'qr_ready');
  assert.deepEqual(fs.readFileSync(png), PNG, 'the same file is the new picture');

  // A second file moves the picture: the old one is removed, so only one code is left lying around.
  const other = path.join(dir, 'b.png');
  assert.equal((await main(['cls', 'login', '--qr', other], undefined, t.guarded())).result.status, 'qr_ready');
  assert.deepEqual([fs.existsSync(png), fs.existsSync(other)], [false, true]);

  // A file that is not the picture's own is never overwritten.
  const mine = path.join(dir, 'report.png');
  fs.writeFileSync(mine, 'something else');
  const refused = await main(['cls', 'login', '--qr', mine], undefined, t.guarded());
  assert.equal(refused.code, 2);
  assert.equal(fs.readFileSync(mine, 'utf8'), 'something else');

  assert.equal((await main(['cls', 'login', '--qr', path.join(dir, 'c.txt')], undefined, t.guarded())).code, 2);
  assert.equal((await main(['cls', 'login', '--qr', path.join(dir, 'cpng')], undefined, t.guarded())).code, 2, 'the dot of .png is a dot');

  t.outcome.next = 'not_login_page';
  const none = await main(['cls', 'login', '--qr', path.join(dir, 'e.png')], undefined, t.guarded());
  assert.deepEqual([none.code, none.result.status, none.result.where, fs.existsSync(path.join(dir, 'e.png'))], [0, 'no_qr', 'somewhere.test/page', false]);
});

test('the picture goes away when the login is done, and a code nobody scanned is cleaned up after a while', async () => {
  const dir = tempDir('ra-qr-clean-');
  const png = path.join(dir, 'cls-login.png');
  const t = qrOnline(dir);
  await main(['cls', 'login', '--qr', png], undefined, t.guarded());
  assert.ok(fs.existsSync(png));

  // Looked at too soon: still there. Looked at after the code could no longer be good: removed.
  const record = JSON.parse(fs.readFileSync(t.recordFile, 'utf8'));
  await t.guarded(() => new Date(record.created_at + 5 * 60_000)).capture(1);
  assert.ok(fs.existsSync(png), 'five minutes: the code may still be scanned');
  await t.guarded(() => new Date(record.created_at + 16 * 60_000)).capture(1);
  assert.deepEqual([fs.existsSync(png), fs.existsSync(t.recordFile)], [false, false]);

  // A login that completes removes it at once.
  await main(['cls', 'login', '--qr', png], undefined, t.guarded());
  assert.ok(fs.existsSync(png));
  const done = qrOnline(dir, ok(alice));
  fs.writeFileSync(done.recordFile, JSON.stringify({ path: png, created_at: Date.now() }));
  assert.equal((await done.guarded().capture(1)).state, 'ok');
  assert.deepEqual([fs.existsSync(png), fs.existsSync(done.recordFile)], [false, false]);
});
