import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { lockProfile, openBrowser } from '../src/gof/chromium.ts';
import { Blocked } from '../src/gof/util.ts';
import { tempDir } from './helpers/tmp.ts';

const lockOf = (profileDir: string) => `${path.resolve(profileDir)}.lock`;

test('a profile is used by one command at a time: another process holding it is waited for, and given up on with a clear reason', async () => {
  const profileDir = path.join(tempDir('ra-lock-'), 'browser-profile');
  // Another command (a process that is alive) holds the profile.
  fs.writeFileSync(lockOf(profileDir), JSON.stringify({ pid: process.pid, at: Date.now() }));
  await assert.rejects(lockProfile(profileDir, 300), (e: Error) => e instanceof Blocked && /另一个命令使用/.test(e.message));
  setTimeout(() => fs.rmSync(lockOf(profileDir), { force: true }), 300);
  const release = await lockProfile(profileDir, 5_000);
  assert.ok(fs.existsSync(lockOf(profileDir)), 'held now by this process');
  release();
  assert.ok(!fs.existsSync(lockOf(profileDir)), 'and let go of');
});

test('a lock left by a command that has ended, or never finished being written long ago, is taken over', async () => {
  const profileDir = path.join(tempDir('ra-lock-'), 'browser-profile');
  const ended = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  fs.mkdirSync(path.dirname(profileDir), { recursive: true });
  fs.writeFileSync(lockOf(profileDir), JSON.stringify({ pid: Number(ended.stdout), at: Date.now() }));
  (await lockProfile(profileDir, 1_000))();
  fs.writeFileSync(lockOf(profileDir), '');
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lockOf(profileDir), old, old);
  (await lockProfile(profileDir, 1_000))();
});

test('within one process the lock is shared, and let go of only when every holder has', async () => {
  const profileDir = path.join(tempDir('ra-lock-'), 'browser-profile');
  const first = await lockProfile(profileDir, 1_000);
  const second = await lockProfile(profileDir, 1_000);
  first();
  first();
  assert.ok(fs.existsSync(lockOf(profileDir)), 'still held by the second');
  second();
  assert.ok(!fs.existsSync(lockOf(profileDir)));
});

test('a browser that is running but slow to answer is not taken for gone: no second one is started and its port file stays', async () => {
  // Answers /json/version like a browser, but its DevTools socket cannot be joined.
  const server = http.createServer((request, response) => {
    if (request.url === '/json/version') response.end('{"Browser":"Chrome"}');
    else { response.statusCode = 404; response.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const profileDir = path.join(tempDir('ra-lock-'), 'browser-profile');
    fs.mkdirSync(profileDir, { recursive: true });
    const portFile = path.join(profileDir, 'DevToolsActivePort');
    fs.writeFileSync(portFile, `${(server.address() as AddressInfo).port}\n/devtools/browser/abc`);
    await assert.rejects(openBrowser({ exe: path.join(profileDir, 'no-such-browser.exe'), profileDir }), /调试接口没有响应/);
    assert.ok(fs.existsSync(portFile), 'the running browser can still be found');
    assert.ok(!fs.existsSync(lockOf(profileDir)), 'and the refusal let go of the lock');
  } finally { server.close(); }
});

test('the port file of a browser that is gone is no obstacle: the start is tried', async () => {
  const profileDir = path.join(tempDir('ra-lock-'), 'browser-profile');
  fs.mkdirSync(profileDir, { recursive: true });
  const free = http.createServer();
  await new Promise<void>(resolve => free.listen(0, '127.0.0.1', resolve));
  const port = (free.address() as AddressInfo).port;
  await new Promise<void>(resolve => free.close(() => resolve()));
  fs.writeFileSync(path.join(profileDir, 'DevToolsActivePort'), `${port}\n/devtools/browser/abc`);
  await assert.rejects(openBrowser({ exe: path.join(profileDir, 'no-such-browser.exe'), profileDir }), /浏览器没有启动成功/);
  assert.ok(!fs.existsSync(lockOf(profileDir)));
});
