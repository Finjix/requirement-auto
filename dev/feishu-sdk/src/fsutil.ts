import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { BridgeError } from './errors.ts';

const run = promisify(execFile);
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export async function readJson<T>(file: string): Promise<T | undefined> {
  let text: string;
  try { text = await fs.readFile(file, 'utf8'); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
  try { return JSON.parse(text) as T; } catch { return undefined; }
}

/** On Windows the file mode means nothing: limit the file to the current account and SYSTEM (best effort, like lark-agent does for .env). */
async function restrictToCurrentAccount(file: string): Promise<void> {
  if (process.platform !== 'win32') return;
  try {
    const { stdout } = await run('whoami.exe', [], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    await run('icacls.exe', [file, '/inheritance:r', '/grant:r', `${stdout.trim()}:(F)`, '*S-1-5-18:(F)'], { windowsHide: true, timeout: 5000 });
  } catch { /* the directory's own permissions still apply */ }
}

/** Writes through a temporary file in the same directory and renames it, so a reader never sees half a file. */
export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await fs.writeFile(temp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await restrictToCurrentAccount(temp);
    for (let attempt = 0; ; attempt++) {
      try { await fs.rename(temp, file); return; } catch (e) {
        // Windows refuses to replace a file another process has open for a moment.
        const code = (e as NodeJS.ErrnoException).code;
        if (attempt >= 20 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw e;
        await sleep(25 * (attempt + 1));
      }
    }
  } finally {
    await fs.rm(temp, { force: true }).catch(() => {});
  }
}

export async function removeFile(file: string): Promise<void> {
  await fs.rm(file, { force: true });
}

export interface LockOptions { timeoutMs?: number; staleMs?: number; pollMs?: number }

/**
 * A lock file created exclusively. A lock nobody renewed for `staleMs` is taken over; the takeover goes through a rename so that
 * of several waiters seeing the same dead lock only one wins it.
 */
export async function withLock<T>(file: string, body: () => Promise<T>, options: LockOptions = {}): Promise<T> {
  const { timeoutMs = 30_000, staleMs = 60_000, pollMs = 40 } = options;
  await fs.mkdir(path.dirname(file), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const handle = await fs.open(file, 'wx');
      await handle.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() }));
      await handle.close();
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    try {
      const age = Date.now() - (await fs.stat(file)).mtimeMs;
      if (age > staleMs) {
        const claimed = `${file}.stale-${process.pid}-${randomBytes(4).toString('hex')}`;
        await fs.rename(file, claimed).then(() => fs.rm(claimed, { force: true }), () => {});
        continue;
      }
    } catch { continue; } // released between the two checks
    if (Date.now() > deadline) throw new BridgeError('network', '另一个进程正在刷新飞书登录，等待超时，请稍后重试');
    await sleep(pollMs);
  }
  try { return await body(); } finally { await fs.rm(file, { force: true }).catch(() => {}); }
}
