import fs from 'node:fs';
import path from 'node:path';
import { events, loadBatch } from './batch.ts';
import { ClsError, createClsAdapter } from './cls-adapter.ts';
import { guardOnline, readPin, writeQr } from './cls-guard.ts';
import { captureAuthorization, captureLoginQr, clsAccountFile, clsProfileDir, clsQrFile, openSession, type Account, type Capture, type ConsentOptions } from './cls-session.ts';
import { checkSeal, rejectSecrets } from './seal.ts';
import { Blocked, isInside, need, readJson, writeJsonNew } from './util.ts';

/*
 * The commands that go online: `gof.mjs cls login | session | catalog | observe | run | read-draft | verify`.
 * Each one gets a session by itself (the login kept in this user's browser profile), does its work over HTTP with the token it
 * saw, and forgets the token when it ends. The batch rules are unchanged: a write needs its recorded attempt first, and the
 * result of a write is only ever read back, never repeated.
 */

type Result = Record<string, any>;

export interface Session { authorization: string; account: Account; origin: string }
export interface Online {
  /** A hidden browser on the saved login: the session, or a refusal that says to log in. */
  session: () => Promise<Session>;
  /** One look in a hidden browser for a login that is already there, waiting up to this long. */
  capture: (waitMs: number) => Promise<Capture>;
  /** The CLS account this user's login is pinned to, once there is one. */
  expectedAccount?: () => { id: number; name: string } | undefined;
  /** Leaves a hidden browser on the sign-in page and writes a picture of its QR code to the file. */
  loginQr?: (file: string) => Promise<QrOutcome>;
}

export type QrOutcome = { state: 'qr'; file: string } | { state: 'not_login_page'; where: string };

/** The one consent page that is approved after a scan: the CLS application's own, for the account this login is pinned to. */
export const CONSENT_APP = 'dsc_admin';
function consentOptions(): ConsentOptions {
  return { app: CONSENT_APP, account: readPin(clsAccountFile())?.name || undefined };
}

const rawOnline: Online = {
  session: () => openSession({ consent: consentOptions() }),
  capture: waitMs => captureAuthorization({ profileDir: clsProfileDir(), waitMs, consent: consentOptions() }),
  loginQr: async file => {
    const result = await captureLoginQr({ profileDir: clsProfileDir() });
    return result.state === 'qr' ? { state: 'qr', file: writeQr(clsQrFile(), file, result.png) } : result;
  },
};

/** Built per call: the user's directories come from the environment of the process that runs the command. */
function guardedOnline(): Online {
  return guardOnline(rawOnline, {
    pinFile: clsAccountFile(), qrFile: clsQrFile(), profileDir: clsProfileDir(),
  });
}

export const realOnline: Online = {
  session: () => guardedOnline().session(),
  capture: waitMs => guardedOnline().capture(waitMs),
  expectedAccount: () => guardedOnline().expectedAccount?.(),
  loginQr: file => guardedOnline().loginQr!(file),
};

function adapterFor(session: Session, extra: { beforeWrite?: (op: Result) => void } = {}) {
  return createClsAdapter({ origin: session.origin, authorization: session.authorization, ...extra });
}

const account = (a: Account) => ({ id: a.id, name: a.name });

/**
 * The login: the QR code of the sign-in page goes to a picture file for the user to scan with their phone, and the
 * hidden browser that shows it keeps running. After the scan, `cls session` (or `cls login`) takes the login from that browser.
 */
export async function loginWithQr(online: Online, file: string): Promise<Result> {
  need(/\.png$/i.test(file), '二维码文件需要是 .png');
  const quiet = await online.capture(12_000);
  if (quiet.state === 'ok') return { status: 'logged_in', account: account(quiet.account) };
  if (quiet.state === 'consent_refused') throw new Blocked(quiet.reason);
  need(online.loginQr, '这个环境不能用二维码登录');
  const outcome = await online.loginQr(path.resolve(file));
  if (outcome.state === 'not_login_page') {
    return { status: 'no_qr', where: outcome.where, message: '页面没有停在登录二维码上（可能已经登录，或正在跳转）；先运行 gof.mjs cls session 看一眼，仍未登录再重新运行本命令' };
  }
  const expected = online.expectedAccount?.();
  return {
    status: 'qr_ready', qr_file: outcome.file, ...(expected ? { expected_account: expected.name } : {}),
    message: `二维码已生成。把它发给用户，请其用飞书手机端扫码并在手机上确认${expected ? `（账号应为“${expected.name}”）` : ''}；二维码几分钟后失效，失效就重新运行本命令。用户说已确认后运行 gof.mjs cls session`,
  };
}

/** Is the CLS login good right now? One look in a hidden browser, with the real session behind it: ok | login_required | blocked. */
export async function check(online: Online): Promise<Result> {
  try {
    const seen = await online.capture(25_000);
    if (seen.state === 'ok') return { status: 'ok', account: account(seen.account) };
    if (seen.state === 'consent_refused') return { status: 'blocked', reason: seen.reason };
    return { status: 'login_required' };
  } catch (error) {
    if (error instanceof Blocked) return { status: 'blocked', reason: error.message };
    throw error;
  }
}

export async function sessionStatus(online: Online): Promise<Result> {
  const session = await online.session();
  return { status: 'logged_in', account: account(session.account) };
}

export async function catalog(online: Online, output: string): Promise<Result> {
  const file = path.resolve(output);
  need(!fs.existsSync(file), '目录文件已存在，不覆盖');
  const session = await online.session();
  const result = await adapterFor(session).readCatalog();
  rejectSecrets(result);
  writeJsonNew(file, result);
  return { status: 'catalog_saved', catalog: file, account: account(session.account), can_create: result.can_create, can_import: result.can_import };
}

/**
 * The conditions `cls-check` asks for, taken from what CLS says right now instead of from a person's report.
 * `required_complete` is true because the operation file that follows is only built from a request with every required field;
 * `import_would_publish` is false because the import endpoint only adds scripts to the draft (publishing is a different, forbidden call)
 * and the read-back after the import fails if the draft is no longer unpublished.
 */
export async function observe(online: Online, action: string, output: string, draftId?: number): Promise<Result> {
  need(['save_draft', 'import_scripts'].includes(action), '只允许草稿创建和脚本导入');
  const file = path.resolve(output);
  need(!fs.existsSync(file), '观察文件已存在，不覆盖');
  const session = await online.session();
  const api = adapterFor(session);
  const current = await api.readCatalog();
  let observations: Result;
  if (action === 'save_draft') {
    observations = { logged_in: true, can_create: current.can_create, unpublished: true, save_result: 'none', required_complete: true };
  } else {
    need(Number.isSafeInteger(draftId) && (draftId as number) > 0, '导入需要 --draft 草稿 ID');
    const parent = await api.readDraft(draftId as number);
    observations = {
      logged_in: true, can_create: current.can_create, unpublished: parent.status === -2, draft_saved: true, save_result: 'ok',
      import_enabled: current.can_import === true && (parent.is_edit === true || parent.is_edit === 1) && parent.sub_scripts.length === 0
        && parent.user_id === session.account.id,
      import_would_publish: false,
    };
  }
  writeJsonNew(file, observations);
  return { status: 'observations_saved', observations: file, ...observations };
}

function loadOperation(batchDir: string, operationFile: string): { batchPath: string; manifest: Result; op: Result; operationPath: string } {
  const { path: batchPath, manifest } = loadBatch(batchDir);
  const operationPath = path.resolve(operationFile);
  need(isInside(batchPath, operationPath), '操作文件必须位于本批目录');
  const op = readJson(operationPath);
  checkSeal(op, 'operation_id');
  need(op.plan_id === manifest.plan.plan_id, '操作文件不属于本批');
  return { batchPath, manifest, op, operationPath };
}

/**
 * Sends one sealed operation. The attempt has to be recorded in the batch first, and a marker file is created just before the write goes
 * out, so a second run of the same operation (in this session or any other) is refused: what a write did is found out by reading back.
 */
export async function run(online: Online, batchDir: string, operationFile: string, output: string): Promise<Result> {
  const { batchPath, op } = loadOperation(batchDir, operationFile);
  const receiptPath = path.resolve(output);
  need(isInside(batchPath, receiptPath) && !fs.existsSync(receiptPath), '接口记录须新建于本批目录内');
  const attempts = events(batchPath).filter(e => e.group === op.group && e.step === 'cls_api_attempt' && e.evidence.operation_id === op.operation_id);
  need(attempts.length === 1, '先用 batch record --step cls_api_attempt 记录本次尝试');
  const marker = path.join(batchPath, `cls-sent-${String(op.operation_id).slice(0, 16)}.json`);
  const session = await online.session();
  need(session.account.id === op.account_id, '当前登录的 CLS 账号与操作文件不是同一个');
  const api = adapterFor(session, {
    beforeWrite: operation => {
      try { writeJsonNew(marker, { operation_id: operation.operation_id, action: operation.action, at: new Date().toISOString() }); }
      catch { throw new ClsError('本操作已经发出过写请求；先用 read-draft 回读核对，不重发', 'unknown'); }
    },
  });
  const receipt = op.action === 'save_draft' ? await api.createDraft(op) : await api.importScripts(op);
  writeJsonNew(receiptPath, receipt);
  return {
    status: 'receipt_saved', receipt: receiptPath, action: op.action, draft_id: receipt.parent.id,
    requirement_number: receipt.parent.number ?? null, url: `${session.origin}/requirement/${receipt.parent.id}/edit-outer`,
    scripts: receipt.parent.sub_scripts.length,
  };
}

export async function readDraft(online: Online, draftId: number): Promise<Result> {
  need(Number.isSafeInteger(draftId) && draftId > 0, '需要 --id 草稿 ID');
  return { status: 'draft', draft: await adapterFor(await online.session()).readDraft(draftId) };
}

/** A read-only receipt for a draft that is already there, for recovering after a write whose outcome was not known. */
export async function verifyDraft(online: Online, batchDir: string, operationFile: string, draftId: number, output: string): Promise<Result> {
  const { batchPath, op } = loadOperation(batchDir, operationFile);
  const receiptPath = path.resolve(output);
  need(isInside(batchPath, receiptPath) && !fs.existsSync(receiptPath), '接口记录须新建于本批目录内');
  need(Number.isSafeInteger(draftId) && draftId > 0, '需要 --draft 草稿 ID');
  const session = await online.session();
  need(session.account.id === op.account_id, '当前登录的 CLS 账号与操作文件不是同一个');
  const receipt = await adapterFor(session).verify(op, draftId);
  writeJsonNew(receiptPath, receipt);
  return { status: 'receipt_saved', receipt: receiptPath, action: op.action, draft_id: receipt.parent.id, requirement_number: receipt.parent.number ?? null };
}
