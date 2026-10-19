import fs from 'node:fs';
import path from 'node:path';
import { events, loadBatch } from './batch.ts';
import { ClsError, createClsAdapter } from './cls-adapter.ts';
import { captureAuthorization, clsProfileDir, openSession, type Account, type Capture } from './cls-session.ts';
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
  /** One look at the page for a login, with a window for a person (headed) or without. */
  capture: (headed: boolean, waitMs: number) => Promise<Capture>;
}

export const realOnline: Online = {
  session: () => openSession(),
  capture: (headed, waitMs) => captureAuthorization({ profileDir: clsProfileDir(), headed, waitMs }),
};

function adapterFor(session: Session, extra: { beforeWrite?: (op: Result) => void } = {}) {
  return createClsAdapter({ origin: session.origin, authorization: session.authorization, ...extra });
}

const account = (a: Account) => ({ id: a.id, name: a.name });

/** The window stays open when the wait runs out, so the next call picks the login up where the person left it. */
export async function login(online: Online, waitSeconds: number): Promise<Result> {
  need(Number.isFinite(waitSeconds) && waitSeconds >= 5 && waitSeconds <= 600, '--wait 需在 5 到 600 秒之间');
  const quiet = await online.capture(false, 12_000);
  if (quiet.state === 'ok') return { status: 'logged_in', account: account(quiet.account), window: 'not_needed' };
  const shown = await online.capture(true, waitSeconds * 1000);
  if (shown.state === 'ok') return { status: 'logged_in', account: account(shown.account), window: 'closed' };
  if (shown.state === 'closed') throw new Blocked('浏览器窗口在登录完成前被关闭；请重新运行 gof.mjs cls login');
  return {
    status: 'waiting', wait_seconds: waitSeconds,
    message: '已在运行本命令的这台电脑上打开浏览器窗口，请在窗口里完成公司登录；完成后再运行一次 gof.mjs cls login（窗口会自动关闭）',
  };
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
