import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { BridgeReply } from '../src/bridge.ts';
import { main } from '../src/gof/cli.ts';
import { checkVerificationUrl, type DeviceOutcome, type DeviceWeb } from '../src/gof/feishu-web.ts';
import { Bridge } from '../src/gof/feishu.ts';
import { tempDir } from './helpers/tmp.ts';

type Obj = Record<string, any>;
const ok = (data: Obj): BridgeReply => ({ ok: true, data });
const LINK = 'https://accounts.feishu.cn/oauth/v1/device/verify?flow_id=abc&user_code=ABCD-1234';
const pending = (over: Obj = {}) => ok({ logged_in: false, pending_login: { user_code: 'ABCD-1234', verification_uri_complete: LINK, expires_at: Date.now() + 300_000, ...over } });

function web(outcome: DeviceOutcome): DeviceWeb & { requests: { url: string; mode: string }[] } {
  const requests: { url: string; mode: string }[] = [];
  return { requests, drive: async request => { requests.push(request); return outcome; } };
}

/** Runs a command for a scratch user, so that the QR record and the browser profile paths land in a temp dir. */
async function run(args: string[], reply: BridgeReply, device: DeviceWeb) {
  const dir = tempDir('ra-web-');
  const before = process.env.LARK_AGENT_USER_DIR;
  process.env.LARK_AGENT_USER_DIR = dir;
  try { return { dir, ...await main(args, new Bridge(async () => reply), undefined, device) }; } finally {
    if (before === undefined) delete process.env.LARK_AGENT_USER_DIR; else process.env.LARK_AGENT_USER_DIR = before;
  }
}

test('only the device page of this authorization is ever opened in the browser', () => {
  assert.equal(checkVerificationUrl(LINK, 'ABCD-1234'), LINK);
  for (const bad of ['http://accounts.feishu.cn/oauth/v1/device/verify?user_code=ABCD-1234', 'https://evil.example/oauth/v1/device/verify?user_code=ABCD-1234',
    'https://accounts.feishu.cn.evil.example/oauth/v1/device/verify?user_code=ABCD-1234', 'https://accounts.feishu.cn/other?user_code=ABCD-1234', 'not a url']) {
    assert.throws(() => checkVerificationUrl(bad, 'ABCD-1234'), /拒绝|有效/, bad);
  }
  assert.throws(() => checkVerificationUrl(LINK, 'WXYZ-9999'), /验证码不符/);
});

test('feishu authorize --qr: the sign-in QR is written for the user; an existing Feishu web session is approved without a scan', async () => {
  const qr = web({ state: 'qr', png: Buffer.from('png-bytes') });
  const shown = await run(['feishu', 'authorize', '--qr', path.join(tempDir('ra-out-'), 'q.png')], pending(), qr);
  assert.equal(shown.result.status, 'qr_ready');
  assert.deepEqual(qr.requests, [{ url: LINK, mode: 'start' }]);
  assert.equal(fs.readFileSync(shown.result.qr_file, 'utf8'), 'png-bytes');
  assert.equal(shown.code, 0);

  const silent = web({ state: 'approved' });
  const done = await run(['feishu', 'authorize', '--qr', path.join(tempDir('ra-out-'), 'q.png')], pending(), silent);
  assert.equal(done.result.status, 'approved');
  assert.match(done.result.message, /feishu login poll/);
});

test('feishu authorize without --qr finishes after the scan, and says so when nobody has scanned', async () => {
  const finish = web({ state: 'approved' });
  assert.equal((await run(['feishu', 'authorize'], pending(), finish)).result.status, 'approved');
  assert.deepEqual(finish.requests, [{ url: LINK, mode: 'finish' }]);
  assert.equal((await run(['feishu', 'authorize'], pending(), web({ state: 'login_required' }))).result.status, 'login_required');
  assert.equal((await run(['feishu', 'authorize'], pending(), web({ state: 'stuck', where: 'x/y' }))).result.status, 'stuck');
  const refused = await run(['feishu', 'authorize'], pending(), web({ state: 'refused', reason: '不是预期的授权页' }));
  assert.deepEqual([refused.code, refused.result.status, refused.result.reason], [2, 'blocked', '不是预期的授权页']);
});

test('feishu authorize needs a pending, still valid authorization and never opens the browser without one', async () => {
  const none = web({ state: 'approved' });
  assert.equal((await run(['feishu', 'authorize'], ok({ logged_in: false }), none)).result.status, 'no_pending');
  assert.equal((await run(['feishu', 'authorize'], pending({ expires_at: Date.now() - 1 }), none)).result.status, 'no_pending');
  assert.equal((await run(['feishu', 'authorize'], pending({ verification_uri_complete: 'https://evil.example/x?user_code=ABCD-1234' }), none)).code, 2);
  assert.equal(none.requests.length, 0);
});
