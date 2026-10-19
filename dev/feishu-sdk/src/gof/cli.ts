import { parseArgs } from 'node:util';
import path from 'node:path';
import fs from 'node:fs';
import { clsCheck, message, preflight, prepare, record, report, status, verify } from './batch.ts';
import { ClsError } from './cls-adapter.ts';
import { clsPreview, operation } from './cls.ts';
import * as online from './cls-online.ts';
import { Bridge, document, execute, login, planWithApi, probe, reconcile, recomputeApiPlan, takeSnapshot } from './feishu.ts';
import { makePlan } from './plan.ts';
import { Snapshot } from './snapshot.ts';
import { Blocked, checkTarget, isInside, need, readJson, writeJsonNew } from './util.ts';

/*
 * The one entry point of the skill's scripts (server/dist/gof.mjs): `gof.mjs batch …`, `gof.mjs feishu …`, `gof.mjs cls …`.
 * Every command prints one line of canonical JSON on stdout; a refusal is {"status":"blocked","reason":…} and exit code 2.
 */

type Result = Record<string, any>;
type Values = Record<string, string | boolean | undefined>;
const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
const mustHave = (v: unknown, flag: string): string => { need(typeof v === 'string' && v !== '', `缺少 --${flag}`); return v as string; };

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

async function feishuCommand(command: string, args: string[], bridge: Bridge): Promise<Result> {
  switch (command) {
    case 'doctor': return bridge.doctor();
    case 'login': {
      const { values, positionals } = parse(args, { wait: { type: 'string' }, 'probe-scope': { type: 'boolean' } }, true);
      need(positionals.length === 1 && ['start', 'poll', 'status', 'logout'].includes(positionals[0]!), 'login 需要 start、poll、status 或 logout');
      const wait = str(values.wait);
      return login(bridge, positionals[0]!, { ...(wait !== undefined ? { wait: Number(wait) } : {}), probeScope: values['probe-scope'] === true });
    }
    case 'probe': return probe(bridge, mustHave(parse(args, { receipt: { type: 'string' } }).values.receipt, 'receipt'));
    case 'append': {
      const { values } = parse(args, { batch: { type: 'string' }, receipt: { type: 'string' } });
      return execute(bridge, mustHave(values.batch, 'batch'), mustHave(values.receipt, 'receipt'));
    }
    case 'reconcile': return reconcile(bridge, mustHave(parse(args, { batch: { type: 'string' } }).values.batch, 'batch'));
    case 'document': return document(bridge, mustHave(parse(args, { url: { type: 'string' } }).values.url, 'url'));
    case 'snapshot': return takeSnapshot(bridge, mustHave(parse(args, { output: { type: 'string' } }).values.output, 'output'));
    case 'plan': {
      const { values } = parse(args, { snapshot: { type: 'string' }, request: { type: 'string' } });
      const snap = new Snapshot(mustHave(values.snapshot, 'snapshot'));
      try { return await planWithApi(bridge, snap, readJson(mustHave(values.request, 'request'))); } finally { snap.close(); }
    }
    case 'prepare': {
      const { values } = parse(args, { plan: { type: 'string' }, snapshot: { type: 'string' }, 'output-root': { type: 'string' }, workspace: { type: 'string' } });
      const snap = new Snapshot(mustHave(values.snapshot, 'snapshot'));
      try {
        const approved = readJson(mustHave(values.plan, 'plan'));
        const recomputed = await recomputeApiPlan(bridge, snap, approved);
        return prepare(approved.batch_plan, snap, { workspace: str(values.workspace), apiPlan: recomputed, outputRoot: str(values['output-root']) });
      } finally { snap.close(); }
    }
    default: throw new Blocked(`未知的 feishu 子命令：${command}`);
  }
}

const intOf = (v: unknown, flag: string): number => { need(typeof v === 'string' && /^[1-9]\d*$/.test(v), `--${flag} 需要正整数`); return Number(v); };

const CLS_ONLINE = ['login', 'session', 'catalog', 'observe', 'run', 'read-draft', 'verify'];

/** The commands that talk to CLS: they log in through the browser on this user's profile and work over HTTP (see cls-online.ts). */
async function clsOnlineCommand(command: string, args: string[], via: online.Online): Promise<Result> {
  switch (command) {
    case 'login': {
      const wait = str(parse(args, { wait: { type: 'string' } }).values.wait);
      return online.login(via, wait === undefined ? 90 : Number(wait));
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

export async function main(argv: string[], bridge: Bridge = new Bridge(), via: online.Online = online.realOnline): Promise<{ result: Result; code: number }> {
  try {
    const [group, command, ...rest] = argv;
    let result: Result;
    if (group === 'batch') result = batchCommand(command ?? '', rest);
    else if (group === 'feishu') result = await feishuCommand(command ?? '', rest, bridge);
    else if (group === 'cls') result = CLS_ONLINE.includes(command ?? '') ? await clsOnlineCommand(command!, rest, via) : clsCommand(argv.slice(1));
    else throw new Blocked('用法：gof.mjs <batch|feishu|cls> <命令> [参数]');
    const blocked = ['conflict', 'partial'].includes(result.status) || (group === 'feishu' && result.status === 'blocked');
    return { result, code: blocked ? 2 : 0 };
  } catch (error) {
    if (error instanceof ClsError) {
      // After a write of unknown outcome the caller needs to know which draft and operation to read back.
      return { result: { status: 'blocked', reason: error.message, ...(error.kind === 'unknown' ? { unknown_result: true } : {}),
        ...(error.draftId ? { draft_id: error.draftId } : {}), ...(error.operationId ? { operation_id: error.operationId } : {}) }, code: 2 };
    }
    if (error instanceof Blocked || error instanceof Error) return { result: { status: 'blocked', reason: error.message }, code: 2 };
    return { result: { status: 'blocked', reason: String(error) }, code: 2 };
  }
}
