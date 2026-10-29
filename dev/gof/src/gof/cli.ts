import { parseArgs } from 'node:util';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { attachTicket, clsCheck, listBatches, message, preflight, prepare, record, report, status, verify } from './batch.ts';
import { ClsError } from './cls-adapter.ts';
import { clsPreview, operation } from './cls.ts';
import * as online from './cls-online.ts';
import * as creative from './creative-online.ts';
import { parseNumbers } from './creative.ts';
import { docPicture, draftPicture, sheetPicture } from './shots-online.ts';
import { readBrief } from './brief.ts';
import { editDoc, outline } from './doc.ts';
import { context } from './context.ts';
import { addOption, authorizeFeishu, Bridge, execute, login, planSummary, planWithApi, probe, reconcile, recomputePlan, takeSnapshot } from './feishu.ts';
import { makePlan } from './plan.ts';
import { Snapshot } from './snapshot.ts';
import { Blocked, checkTarget, isInside, need, readJson, writeJsonNew, WriteSent } from './util.ts';

/*
 * The one entry point of the skill's scripts (server/dist/gof.mjs): `gof.mjs batch …`, `gof.mjs feishu …`, `gof.mjs cls …`.
 * Every command prints one line of canonical JSON on stdout; a refusal is {"status":"blocked","reason":…} and exit code 2.
 */

type Result = Record<string, any>;
type Values = Record<string, string | boolean | undefined>;
const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
const mustHave = (v: unknown, flag: string): string => { need(typeof v === 'string' && v !== '', `缺少 --${flag}`); return v as string; };

/** The overwrite-protection receipt that ships with the plugin (next to the skill's assets); the bundle sits in server/dist, the sources in dev/feishu-sdk/src/gof. */
function bundledReceipt(): string {
  const rel = 'skills/gof-requirement/assets/overwrite-receipt.json';
  const candidates = ['../../', '../../../../plugins/requirement-auto/'].map(base => fileURLToPath(new URL(base + rel, import.meta.url)));
  return candidates.find(file => fs.existsSync(file)) ?? candidates[0]!;
}

function parse(args: string[], options: Record<string, { type: 'string' | 'boolean' }>, positionals = false): { values: Values; positionals: string[] } {
  try {
    const { values, positionals: rest } = parseArgs({ args, options, allowPositionals: positionals, strict: true });
    return { values: values as Values, positionals: rest };
  } catch (error) {
    throw new Blocked((error as Error).message);
  }
}

function openSnapshot(values: Values): Snapshot | undefined {
  const file = str(values.snapshot);
  if (!file) return undefined;
  checkTarget(str(values['observed-url']) ?? '');
  return new Snapshot(file);
}

function batchCommand(command: string, args: string[]): Result {
  const common = { snapshot: { type: 'string' }, 'observed-url': { type: 'string' }, batch: { type: 'string' } } as const;
  switch (command) {
    case 'plan': {
      const { values } = parse(args, { snapshot: { type: 'string' }, 'observed-url': { type: 'string' }, request: { type: 'string' }, 'current-sheet': { type: 'string' } });
      const snap = openSnapshot(values);
      need(snap, '缺少 --snapshot');
      return makePlan(snap, readJson(mustHave(values.request, 'request')), str(values['current-sheet']));
    }
    case 'prepare': {
      const { values } = parse(args, { snapshot: { type: 'string' }, 'observed-url': { type: 'string' }, plan: { type: 'string' },
        'output-root': { type: 'string' }, workspace: { type: 'string' } });
      const snap = openSnapshot(values);
      need(snap, '缺少 --snapshot');
      return prepare(readJson(mustHave(values.plan, 'plan')), snap, { workspace: str(values.workspace), outputRoot: str(values['output-root']) });
    }
    case 'preflight': {
      const { values } = parse(args, common);
      const snap = openSnapshot(values);
      need(snap, '缺少 --snapshot');
      return preflight(mustHave(values.batch, 'batch'), snap);
    }
    case 'verify': {
      const { values } = parse(args, { ...common, 'validation-evidence': { type: 'string' } });
      const snap = openSnapshot(values);
      need(snap, '缺少 --snapshot');
      const evidence = str(values['validation-evidence']);
      return verify(mustHave(values.batch, 'batch'), snap, evidence ? readJson(evidence) : undefined);
    }
    case 'record': {
      const { values } = parse(args, { ...common, step: { type: 'string' }, group: { type: 'string' }, evidence: { type: 'string' } });
      const snap = openSnapshot(values);
      const evidence = str(values.evidence);
      return record(mustHave(values.batch, 'batch'), mustHave(values.step, 'step'), str(values.group), evidence ? readJson(evidence) : undefined, snap);
    }
    case 'status': return status(mustHave(parse(args, { batch: { type: 'string' } }).values.batch, 'batch'));
    case 'list': {
      const number = str(parse(args, { number: { type: 'string' } }).values.number);
      return listBatches(undefined, number === undefined ? undefined : intOf(number.replace(/^GOFCN/i, ''), 'number'));
    }
    case 'ticket': {
      const { values } = parse(args, { batch: { type: 'string' }, group: { type: 'string' }, ticket: { type: 'string' }, catalog: { type: 'string' },
        preview: { type: 'boolean' } });
      return attachTicket(mustHave(values.batch, 'batch'), mustHave(values.group, 'group'), readJson(mustHave(values.ticket, 'ticket')),
        readJson(mustHave(values.catalog, 'catalog')), values.preview === true);
    }
    case 'message': return message(mustHave(parse(args, { batch: { type: 'string' } }).values.batch, 'batch'));
    case 'cls-check': {
      const { values } = parse(args, { batch: { type: 'string' }, group: { type: 'string' }, action: { type: 'string' }, ui: { type: 'string' }, observations: { type: 'string' } });
      need((values.ui === undefined) !== (values.observations === undefined), '需要且只能给出 --ui 或 --observations 之一');
      return clsCheck(mustHave(values.batch, 'batch'), mustHave(values.group, 'group'), mustHave(values.action, 'action'),
        readJson(mustHave(values.ui ?? values.observations, 'observations')));
    }
    case 'report': {
      const { values } = parse(args, { batch: { type: 'string' }, output: { type: 'string' } });
      const dir = mustHave(values.batch, 'batch');
      const result = report(dir);
      const output = str(values.output);
      if (!output) return result;
      const file = path.resolve(output);
      need(isInside(dir, file), '报告必须位于本批目录');
      writeJsonNew(file, result);
      return { status: 'report_saved', report: file };
    }
    default: throw new Blocked(`未知的 batch 子命令：${command}`);
  }
}

/** Results of the feishu plugin's own commands (login, authorize) come back with its exit code. */
type Forwarded = { forwarded: { result: Result; code: number } };

async function feishuCommand(command: string, args: string[], bridge: Bridge, via: online.Online): Promise<Result | Forwarded> {
  switch (command) {
    case 'screenshot': {
      const { values } = parse(args, { batch: { type: 'string' }, output: { type: 'string' } });
      return sheetPicture(via, mustHave(values.batch, 'batch'), mustHave(values.output, 'output'));
    }
    case 'doctor': return bridge.doctor();
    case 'login': {
      const { values, positionals } = parse(args, { wait: { type: 'string' }, 'probe-scope': { type: 'boolean' } }, true);
      need(positionals.length === 1 && ['start', 'poll', 'status', 'logout'].includes(positionals[0]!), 'login 需要 start、poll、status 或 logout');
      const wait = str(values.wait);
      return { forwarded: await login(positionals[0]!, { ...(wait !== undefined ? { wait: Number(wait) } : {}), probeScope: values['probe-scope'] === true }) };
    }
    case 'authorize': {
      const { values } = parse(args, { qr: { type: 'string' } });
      return { forwarded: await authorizeFeishu(str(values.qr)) };
    }
    case 'probe': return probe(bridge, mustHave(parse(args, { receipt: { type: 'string' } }).values.receipt, 'receipt'));
    case 'append': {
      const { values } = parse(args, { batch: { type: 'string' }, receipt: { type: 'string' } });
      return execute(bridge, mustHave(values.batch, 'batch'), str(values.receipt) || bundledReceipt());
    }
    case 'reconcile': return reconcile(bridge, mustHave(parse(args, { batch: { type: 'string' } }).values.batch, 'batch'));
    case 'document': {
      const { values } = parse(args, { url: { type: 'string' }, sheet: { type: 'string' }, full: { type: 'boolean' }, outline: { type: 'boolean' },
        block: { type: 'string' } });
      if (values.outline || values.block !== undefined) {
        need(values.sheet === undefined, '--outline 只用于新版文档（docx）；表格直接读，行号和列字母就是位置');
        const block = str(values.block);
        need(block === undefined || /^\d+$/.test(block), '--block 需要顶层块的序号（从 0 数）');
        return outline(bridge, mustHave(values.url, 'url'), { full: values.full === true, ...(block !== undefined ? { block: Number(block) } : {}) });
      }
      return readBrief(bridge, mustHave(values.url, 'url'), { ...(str(values.sheet) !== undefined ? { sheet: str(values.sheet)! } : {}), full: values.full === true });
    }
    case 'doc-screenshot': {
      const { values } = parse(args, { url: { type: 'string' }, output: { type: 'string' }, block: { type: 'string' }, sheet: { type: 'string' }, range: { type: 'string' } });
      return docPicture(via, mustHave(values.url, 'url'), { ...(str(values.block) ? { block: str(values.block)! } : {}),
        ...(str(values.sheet) ? { sheet_id: str(values.sheet)! } : {}), ...(str(values.range) ? { range: str(values.range)!.toUpperCase() } : {}) },
      mustHave(values.output, 'output'));
    }
    case 'doc-edit': {
      const { values } = parse(args, { url: { type: 'string' }, edit: { type: 'string' }, check: { type: 'boolean' } });
      return editDoc(bridge, mustHave(values.url, 'url'), readJson(mustHave(values.edit, 'edit')), values.check === true);
    }
    case 'context': {
      const { values } = parse(args, { snapshot: { type: 'string' }, worksheet: { type: 'string' }, supplier: { type: 'string' } });
      const snap = new Snapshot(mustHave(values.snapshot, 'snapshot'));
      try { return await context(bridge, snap, { worksheet: str(values.worksheet) }); } finally { snap.close(); }
    }
    case 'dropdown-add': {
      const { values } = parse(args, { field: { type: 'string' }, option: { type: 'string' }, sheet: { type: 'string' }, color: { type: 'string' } });
      return addOption(bridge, mustHave(values.field, 'field'), mustHave(values.option, 'option'), mustHave(values.sheet, 'sheet'), str(values.color));
    }
    case 'snapshot': return takeSnapshot(bridge, mustHave(parse(args, { output: { type: 'string' } }).values.output, 'output'));
    case 'plan': {
      const { values } = parse(args, { snapshot: { type: 'string' }, request: { type: 'string' }, output: { type: 'string' } });
      const snap = new Snapshot(mustHave(values.snapshot, 'snapshot'));
      const output = str(values.output);
      const file = output === undefined ? undefined : path.resolve(output);
      need(file === undefined || !fs.existsSync(file), '计划文件已存在，不覆盖');
      try {
        const result = await planWithApi(bridge, snap, readJson(mustHave(values.request, 'request')));
        if (file === undefined) return result;
        writeJsonNew(file, result);
        return planSummary(result, file);
      } finally { snap.close(); }
    }
    case 'prepare': {
      const { values } = parse(args, { plan: { type: 'string' }, snapshot: { type: 'string' }, 'output-root': { type: 'string' }, workspace: { type: 'string' } });
      const snap = new Snapshot(mustHave(values.snapshot, 'snapshot'));
      try {
        const approved = readJson(mustHave(values.plan, 'plan'));
        const fresh = await recomputePlan(bridge, snap, approved);
        return prepare(fresh.batch_plan, snap, { workspace: str(values.workspace), apiPlan: fresh.api_plan, outputRoot: str(values['output-root']) });
      } finally { snap.close(); }
    }
    default: throw new Blocked(`未知的 feishu 子命令：${command}`);
  }
}

const intOf = (v: unknown, flag: string): number => { need(typeof v === 'string' && /^[1-9]\d*$/.test(v), `--${flag} 需要正整数`); return Number(v); };

const CLS_ONLINE = ['login', 'session', 'catalog', 'observe', 'run', 'read-draft', 'verify', 'screenshot'];

/** The commands that talk to CLS: they log in through the browser on this user's profile and work over HTTP (see cls-online.ts). */
async function clsOnlineCommand(command: string, args: string[], via: online.Online): Promise<Result> {
  switch (command) {
    case 'login': {
      const { values } = parse(args, { qr: { type: 'string' } });
      const qr = str(values.qr);
      need(qr, 'cls login 需要 --qr <png文件>：登录用二维码，由用户用飞书手机端扫码，不弹出浏览器窗口');
      return online.loginWithQr(via, qr);
    }
    case 'session': parse(args, {}); return online.sessionStatus(via);
    case 'catalog': return online.catalog(via, mustHave(parse(args, { output: { type: 'string' } }).values.output, 'output'));
    case 'observe': {
      const { values } = parse(args, { action: { type: 'string' }, draft: { type: 'string' }, output: { type: 'string' } });
      return online.observe(via, mustHave(values.action, 'action'), mustHave(values.output, 'output'), values.draft === undefined ? undefined : intOf(values.draft, 'draft'));
    }
    case 'run': {
      const { values } = parse(args, { batch: { type: 'string' }, operation: { type: 'string' }, output: { type: 'string' } });
      return online.run(via, mustHave(values.batch, 'batch'), mustHave(values.operation, 'operation'), mustHave(values.output, 'output'));
    }
    case 'screenshot': {
      const { values } = parse(args, { batch: { type: 'string' }, group: { type: 'string' }, output: { type: 'string' } });
      return draftPicture(via, mustHave(values.batch, 'batch'), str(values.group), mustHave(values.output, 'output'));
    }
    case 'read-draft': return online.readDraft(via, intOf(parse(args, { id: { type: 'string' } }).values.id, 'id'));
    case 'verify': {
      const { values } = parse(args, { batch: { type: 'string' }, operation: { type: 'string' }, draft: { type: 'string' }, output: { type: 'string' } });
      return online.verifyDraft(via, mustHave(values.batch, 'batch'), mustHave(values.operation, 'operation'), intOf(values.draft, 'draft'), mustHave(values.output, 'output'));
    }
    default: throw new Blocked(`未知的 cls 子命令：${command}`);
  }
}

function clsCommand(args: string[]): Result {
  const { values } = parse(args, { preview: { type: 'boolean' }, request: { type: 'string' }, batch: { type: 'string' }, group: { type: 'string' },
    action: { type: 'string' }, catalog: { type: 'string' }, observations: { type: 'string' }, output: { type: 'string' } });
  const catalog = readJson(mustHave(values.catalog, 'catalog'));
  if (values.preview) {
    need(values.request && !(values.batch || values.group || values.action || values.output || values.observations), 'preview 只接受 request/catalog');
    return clsPreview(readJson(values.request as string), catalog);
  }
  need(values.batch && values.group && values.action && values.observations && values.output, '需本批、组、动作、观察和新输出路径');
  need(['save_draft', 'import_scripts'].includes(values.action as string), '只允许草稿创建和脚本导入');
  const dir = path.resolve(values.batch as string);
  const output = path.resolve(values.output as string);
  need(isInside(dir, output) && !fs.existsSync(output), '操作文件须新建于本批目录内');
  const op = operation(dir, values.group as string, values.action as string, catalog, readJson(values.observations as string));
  writeJsonNew(output, op);
  return { status: 'operation_ready', operation: output, operation_id: op.operation_id, native_defaults: op.native_defaults };
}

/** The material upload (see creative-online.ts): options, rows and plan only read; run uploads what an approved plan says. */
async function creativeCommand(command: string, args: string[], bridge: Bridge, via: online.Online): Promise<Result> {
  switch (command) {
    case 'options': {
      const { values } = parse(args, { find: { type: 'string' }, creator: { type: 'string' }, producers: { type: 'string' } });
      const producers = str(values.producers)?.split(/[,，、]+/).map(t => t.trim()).filter(Boolean);
      need(producers === undefined || producers.length > 0, '--producers 需要至少一个名字（逗号分开）');
      return creative.uploadOptions(via, { ...(str(values.find) ? { find: str(values.find)! } : {}),
        ...(str(values.creator)?.trim() ? { creator: str(values.creator)!.trim() } : {}), ...(producers ? { producers } : {}) });
    }
    case 'files': {
      const { values, positionals } = parse(args, { check: { type: 'boolean' }, progress: { type: 'string' } }, true);
      need(positionals.length > 0, 'creative files 需要文件、文件夹或 zip 的路径');
      need(values.check || values.progress === undefined, '--progress 只和 --check 一起用');
      const progress = str(values.progress);
      return creative.listFiles(positionals, {}, values.check ? { bridge, progress: progress ?? true } : undefined);
    }
    case 'rows': {
      const { values } = parse(args, { numbers: { type: 'string' }, find: { type: 'string' }, progress: { type: 'string' } });
      const numbers = str(values.numbers) ? parseNumbers(str(values.numbers)!) : [];
      const texts = (str(values.find) ?? '').split(/[,，、]+/).map(t => t.trim()).filter(Boolean);
      need(texts.length <= 20 && texts.every(t => [...t].length <= 50), '--find 最多 20 段文字（逗号分开），每段 50 字以内');
      const progress = str(values.progress);
      return creative.findRows(bridge, { numbers, texts, ...(progress ? { progress } : {}) });
    }
    case 'plan': {
      const { values } = parse(args, { request: { type: 'string' }, output: { type: 'string' } });
      return creative.planUpload(via, bridge, mustHave(values.request, 'request'), mustHave(values.output, 'output'));
    }
    case 'run': return creative.runUpload(via, mustHave(parse(args, { plan: { type: 'string' } }).values.plan, 'plan'));
    case 'status': return creative.uploadStatus(mustHave(parse(args, { plan: { type: 'string' } }).values.plan, 'plan'));
    case 'screenshot': {
      const { values } = parse(args, { output: { type: 'string' }, rows: { type: 'string' } });
      return creative.listPicture(via, mustHave(values.output, 'output'), values.rows === undefined ? undefined : intOf(values.rows, 'rows'));
    }
    default: throw new Blocked(`未知的 creative 子命令：${command}`);
  }
}

/**
 * The two logins, checked for real: Feishu by asking Feishu, CLS by looking in the browser that holds its session. Each task starts
 * with this, and so does each stage that follows a wait (see SKILL.md), so that a login that has lapsed is found before any work
 * depends on it. It changes nothing and takes nothing from the user; what to do about a failure is the caller's business.
 *
 * Feishu comes first and the user is asked for one login at a time: while the Feishu login is missing, CLS is not looked at (no
 * browser is started) and the only thing to do is the Feishu login. The CLS QR is asked for by the next check, once Feishu is ok.
 */
async function loginCheck(bridge: Bridge, via: online.Online): Promise<Result> {
  const feishu = await bridge.checkLogin();
  if (feishu.status === 'login_required' || feishu.status === 'scopes_missing') {
    return {
      status: 'login_required', feishu,
      cls: { status: 'not_checked', reason: 'Feishu login comes first; CLS is checked after it' },
      todo: ['Feishu: run gof.mjs feishu login start (keep its link to yourself), then gof.mjs feishu authorize --qr feishu-login.png and send the QR image to the user only, to scan with the Feishu phone app. That one scan also covers CLS. Ask for nothing else until Feishu is ok'],
    };
  }
  const cls = await online.check(via);
  const sides = [feishu.status, cls.status];
  // A block comes first: logging in again does not fix it, so nobody should be asked to scan or authorize before it is reported.
  const status = sides.every(s => s === 'ok') ? 'ok' : sides.some(s => s === 'blocked' || s === 'identity_mismatch') ? 'blocked'
    : cls.status === 'login_required' && feishu.status === 'ok' ? 'login_required' : 'unknown';
  const todo: string[] = [];
  if (status === 'login_required') todo.push('CLS: run gof.mjs cls login --qr cls-login.png and send the QR image to the user only, to scan with the Feishu phone app');
  return { status, feishu, cls, ...(todo.length ? { todo } : {}) };
}

export async function main(argv: string[], bridge: Bridge = new Bridge(), via: online.Online = online.realOnline): Promise<{ result: Result; code: number }> {
  try {
    const [group, command, ...rest] = argv;
    let result: Result;
    if (group === 'batch') result = batchCommand(command ?? '', rest);
    else if (group === 'feishu') {
      const answer = await feishuCommand(command ?? '', rest, bridge, via);
      if ('forwarded' in answer) return answer.forwarded as { result: Result; code: number };
      result = answer;
    }
    else if (group === 'login' && command === 'check') result = await loginCheck(bridge, via);
    else if (group === 'cls') result = CLS_ONLINE.includes(command ?? '') ? await clsOnlineCommand(command!, rest, via) : clsCommand(argv.slice(1));
    else if (group === 'creative') result = await creativeCommand(command ?? '', rest, bridge, via);
    else throw new Blocked('用法：gof.mjs <batch|feishu|cls|creative|login> <命令> [参数]');
    const blocked = ['conflict', 'not_applied'].includes(result.status) || (result.status === 'partial' && group !== 'creative')
      || (group === 'feishu' && result.status === 'blocked') || (group === 'login' && result.status !== 'ok')
      || (group === 'creative' && ['blocked', 'unknown'].includes(result.status));
    return { result, code: blocked ? 2 : 0 };
  } catch (error) {
    if (error instanceof ClsError) {
      // After a write of unknown outcome the caller needs to know which draft and operation to read back.
      return { result: { status: 'blocked', reason: error.message, ...(error.kind === 'unknown' ? { unknown_result: true } : {}),
        ...(error.draftId ? { draft_id: error.draftId } : {}), ...(error.operationId ? { operation_id: error.operationId } : {}) }, code: 2 };
    }
    // After a write went out the caller must read back, never plan again: said in a field, not only in the wording of the reason.
    if (error instanceof WriteSent) return { result: { status: 'blocked', reason: error.message, write_sent: true, batch: error.batch }, code: 2 };
    if (error instanceof Blocked || error instanceof Error) return { result: { status: 'blocked', reason: error.message }, code: 2 };
    return { result: { status: 'blocked', reason: String(error) }, code: 2 };
  }
}
