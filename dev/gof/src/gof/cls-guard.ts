import fs from 'node:fs';
import path from 'node:path';
import { attachBrowser } from './chromium.ts';
import type { Online } from './cls-online.ts';
import type { Account, Capture } from './cls-session.ts';
import { Blocked } from './util.ts';

/*
 * Guards around the CLS login, for a host where several users share one computer:
 *
 *  - The account pin. CLS cannot tell us which Feishu user a company account belongs to, so the first account that logs in on a
 *    user's profile is remembered (id and name only) and any later login by a different account is refused. It does not prove that
 *    the first login was the right person, but it stops a wrong account from replacing it unnoticed.
 *  - The QR picture's record, below: it removes the picture once the login is done, and a browser nobody scanned for.
 */

export interface Pin { id: number; name: string; pinned_at: string }

export function readPin(file: string): Pin | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<Pin>;
    return Number.isSafeInteger(value.id) ? { id: value.id as number, name: String(value.name ?? ''), pinned_at: String(value.pinned_at ?? '') } : undefined;
  } catch { return undefined; }
}

const CORRUPT_PIN = '这个用户的 CLS 账号绑定记录损坏（文件存在但读不出），已拒绝登录；需要管理员核对或清除 cls/account.json 后重新登录。';

/** The pin as it is on disk: absent, good, or present but unreadable (which must never count as "no pin"). */
export function pinState(file: string): { state: 'none' } | { state: 'ok'; pin: Pin } | { state: 'corrupt' } {
  if (!fs.existsSync(file)) return { state: 'none' };
  const pin = readPin(file);
  return pin ? { state: 'ok', pin } : { state: 'corrupt' };
}

/** Remembers the first account seen on this profile, and refuses a different one afterwards. */
export function checkPin(file: string, account: Account, now: () => Date = () => new Date()): void {
  const present = pinState(file);
  if (present.state === 'corrupt') throw new Blocked(CORRUPT_PIN);
  let pin = present.state === 'ok' ? present.pin : undefined;
  if (!pin) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      fs.writeFileSync(file, `${JSON.stringify({ id: account.id, name: account.name, pinned_at: now().toISOString() }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const again = pinState(file); // another command of this user pinned it a moment ago
      if (again.state !== 'ok') throw new Blocked(CORRUPT_PIN);
      pin = again.pin;
    }
  }
  if (pin && pin.id !== account.id) {
    throw new Blocked(
      `这个用户的 CLS 账号已绑定为“${pin.name}”，这次登录的是另一个账号，已拒绝。请用“${pin.name}”的公司账号登录；`
      + '如果确实要更换账号，需要管理员清除该用户的 CLS 登录资料后重新登录。');
  }
}

/*
 * The QR picture. `cls login --qr` leaves a hidden browser running on the sign-in page and a picture of its code in the user's
 * delivery folder; the record says where the picture is and since when, so that the picture can be removed once the login is done and a
 * browser nobody scanned for is not left running for good.
 */
export interface QrRecord { path: string; created_at: number }

export const QR_MAX_AGE_MS = 15 * 60_000;

export function readQr(file: string): QrRecord | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<QrRecord>;
    return typeof value.path === 'string' && typeof value.created_at === 'number' ? { path: value.path, created_at: value.created_at } : undefined;
  } catch { return undefined; }
}

/** Writes the picture. A file that is not the previous picture is never overwritten. */
export function writeQr(recordFile: string, target: string, png: Buffer, now: () => number = Date.now): string {
  const file = path.resolve(target);
  if (!/\.png$/i.test(file)) throw new Blocked('二维码文件需要是 .png');
  const previous = readQr(recordFile);
  if (fs.existsSync(file) && previous?.path !== file) throw new Blocked('这个文件已存在，不覆盖；换一个新的 .png 文件名');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, png);
  if (previous && previous.path !== file) fs.rmSync(previous.path, { force: true });
  fs.mkdirSync(path.dirname(recordFile), { recursive: true });
  fs.writeFileSync(recordFile, JSON.stringify({ path: file, created_at: now() }), 'utf8');
  return file;
}

/** The login is done (or given up): the picture and its record go away. */
export function clearQr(recordFile: string): void {
  const record = readQr(recordFile);
  if (record && /\.png$/i.test(record.path)) fs.rmSync(record.path, { force: true });
  fs.rmSync(recordFile, { force: true });
}

/** A code nobody scanned in a long time: close the hidden browser waiting for it and remove the picture. */
export async function reapStaleQr(recordFile: string, profileDir: string, now: () => number = Date.now): Promise<void> {
  const record = readQr(recordFile);
  if (!record || now() - record.created_at < QR_MAX_AGE_MS) return;
  const browser = await attachBrowser(profileDir);
  if (browser) await browser.close();
  clearQr(recordFile);
}

export interface GuardOptions {
  pinFile: string;
  now?: () => Date;
  /** Where the QR picture is recorded, and the profile whose browser waits for it. Without them the QR login is not guarded. */
  qrFile?: string;
  profileDir?: string;
}

/** The real session, with the account pin on every login. */
export function guardOnline(inner: Online, options: GuardOptions): Online {
  const { pinFile, now, qrFile, profileDir } = options;
  const reap = async (): Promise<void> => { if (qrFile && profileDir) await reapStaleQr(qrFile, profileDir, now ? () => now().getTime() : Date.now); };
  const done = (): void => { if (qrFile) clearQr(qrFile); };
  const checked = (result: Capture): Capture => {
    if (result.state === 'ok') { checkPin(pinFile, result.account, now); done(); }
    return result;
  };
  return {
    session: async () => {
      await reap();
      const session = await inner.session();
      checkPin(pinFile, session.account, now);
      done();
      return session;
    },
    capture: async waitMs => {
      await reap();
      return checked(await inner.capture(waitMs));
    },
    expectedAccount: () => readPin(pinFile),
    ...(inner.loginQr ? { loginQr: (file: string) => inner.loginQr!(file) } : {}),
  };
}
