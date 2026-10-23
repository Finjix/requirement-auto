import fs from 'node:fs';
import path from 'node:path';
import { ClsError } from './cls-adapter.ts';
import { createCreativeAdapter, signatureEnd, type CreativeAdapter, type CreativeAdapterConfig } from './creative-adapter.ts';
import {
  appendUploadEvent, buildUploadPlan, DEFAULT_DIRECTORY, findDirectory, flattenDirectories, hashFile, isZip, loadUploadPlan, lookupRows,
  materialRefusal, nameParts, normalizeUploadRequest, pendingBody, scanMaterials, searchProgressRows, shownFile, uploadEvents, uploadPlanSummary,
  type DirNode, type ProgressRow, type Skipped, type UploadOptions, type UploadRequest,
} from './creative.ts';
import { unpackZip } from './unzip.ts';
import type { Online, Session } from './cls-online.ts';
import { clsProfileDir } from './cls-session.ts';
import { listScreenshot, type ShotOptions } from './creative-shot.ts';
import { target, type Bridge } from './feishu.ts';
import { Snapshot } from './snapshot.ts';
import { resolveDataPaths } from '../paths.ts';
import { UNPACKED } from '../retention.ts';
import { Blocked, feishuDocPath, need, readJson, writeJsonNew } from './util.ts';

/*
 * The commands of the material upload that go online: `gof.mjs creative options | rows | plan | run | status`.
 * `plan` and `rows` only read (CLS options, existing names, the progress sheet); `run` does the upload the approved plan describes.
 * A run keeps its record in the user's batch directory, so running it again goes on from where it stopped: before the create, the files
 * are simply put up again; once the create has been sent it is never sent again, and what it did is read back instead.
 */

type Obj = Record<string, any>;
export const LIST_URL = 'https://creative.centurygames.cn/creativities';

/** Test seams: a local CLS and storage, short waits. Production passes nothing. */
export interface UploadDeps {
  adapter?: Partial<CreativeAdapterConfig>;
  batchRoot?: string;
  tmpDir?: string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  /** How long to look for creatives a create of unknown outcome may have made. */
  reconcileTries?: number;
}

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function adapterFor(session: Session, deps: UploadDeps, extra: Partial<CreativeAdapterConfig> = {}): CreativeAdapter {
  return createCreativeAdapter({ origin: session.origin, authorization: session.authorization, ...deps.adapter, ...extra });
}

/** What the page 上传创意 offers this account in GOFCN: upload directories, 创意人 and 制作人 candidates, 素材类型. */
export async function readOptions(api: CreativeAdapter, session: Session): Promise<UploadOptions> {
  const [games, account, permissions] = await Promise.all([api.games(), api.account(), api.permissions()]);
  need(Array.isArray(games) && account && typeof permissions === 'object', 'CLS 返回结构变化，停止');
  const game = (games as Obj[]).find(g => g.code === 'GOFCN');
  need(game && Number.isSafeInteger(game.id), `CLS 账号“${session.account.name}”没有 GOFCN 项目的创意权限`);
  need(account.id === session.account.id && account.status === 1, 'CLS 当前账号无法核对');
  // The page goes by the role this account has in the game's group; without one, by its own roles.
  const group = (account.group_permissions ?? []).find((p: Obj) => Array.isArray(p.project_ids) && p.project_ids.includes(game.id));
  const roles: string[] = group?.role_id ? [group.role_id] : account.roles ?? [];
  const granted = new Set(roles.flatMap(role => permissions[role] ?? []));
  const pages = group?.permissions?.pages;
  const [directories, people, types] = await Promise.all([api.directories(game.id), api.people(game.id), api.types(game.id)]);
  need(Array.isArray(directories) && Array.isArray(people?.creative_users) && Array.isArray(people?.producers) && Array.isArray(types?.types), 'CLS 上传选项结构变化，停止');
  const pick = (list: Obj[]) => list.filter(p => Number.isSafeInteger(p.id)).map(p => ({ id: p.id as number, name: String(p.name) }));
  return {
    account: { id: account.id, name: account.name }, game: { id: game.id, code: game.code, name: game.name },
    can_upload: granted.has('creative.upload') && (!Array.isArray(pages) || pages.includes('PAGE_MODULE_CREATIVE')),
    directories: directories as DirNode[], creators: pick(people.creative_users), producers: pick(people.producers),
    types: (types.types as Obj[]).map(t => ({ id: String(t.id), name: String(t.name) })),
  };
}

export async function uploadOptions(online: Online, find?: string, deps: UploadDeps = {}): Promise<Obj> {
  const session = await online.session();
  const options = await readOptions(adapterFor(session, deps), session);
  let defaultDirectory: Obj | null = null;
  try { defaultDirectory = findDirectory(options.directories, DEFAULT_DIRECTORY); } catch { /* reported as null */ }
  const all = flattenDirectories(options.directories);
  return {
    status: 'creative_options', account: options.account, game: options.game, can_upload: options.can_upload,
    default_directory: defaultDirectory,
    // Without --find only the first level under the game; with it, the directories whose own name contains the text, shallowest first.
    directories: find
      ? all.filter(d => d.name.includes(find)).sort((a, b) => a.path.split(' / ').length - b.path.split(' / ').length).slice(0, 50).map(d => d.path)
      : all.filter(d => d.path.split(' / ').length === 2).map(d => d.path),
    creators: options.creators.map(p => p.name), producers: options.producers.map(p => p.name), types: options.types.map(t => t.name),
  };
}

/** Exact names CLS already has a creative of, confirmed or waiting for confirmation (待确认). */
async function existingNames(api: CreativeAdapter, gameId: number, names: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  const queue = [...new Set(names)];
  const worker = async () => {
    for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
      for (const confirmed of [true, false]) {
        const data = await api.search(gameId, name, confirmed);
        if ((data?.creatives ?? []).some((c: Obj) => c.name === name)) found.add(name);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker));
  return found;
}

/** The spreadsheet a progress sheet link (wiki node or sheets link) points at. */
async function sheetToken(bridge: Bridge, url: string): Promise<{ token: string; title: string }> {
  const docPath = feishuDocPath(url, 'wiki|sheets', true);
  need(docPath, '进度表链接需要是公司飞书的 wiki 或 sheets 链接');
  const [, kind, token] = docPath.replace(/\/$/, '').split('/') as [string, string, string];
  if (kind === 'sheets') return { token, title: '' };
  const node = (await bridge.apiRead('/open-apis/wiki/v2/spaces/get_node', { token, obj_type: 'wiki' })).node;
  need(node?.obj_type === 'sheet' && /^[A-Za-z0-9]+$/.test(String(node.obj_token ?? '')), '这个链接不是电子表格');
  return { token: node.obj_token, title: String(node.title ?? '') };
}

/** A fresh export of the plugin's progress sheet, or of the sheet the user linked, read by `use` and removed again. */
async function readProgressSheet<T>(bridge: Bridge, source: true | string, tmpDir: string, use: (snapshot: Snapshot, label: string) => T): Promise<T> {
  await bridge.doctor();
  const { token, title } = source === true ? { token: await target(bridge), title: '' } : await sheetToken(bridge, source);
  fs.mkdirSync(tmpDir, { recursive: true });
  const file = path.join(tmpDir, `progress-lookup-${Date.now()}-${process.pid}.xlsx`);
  await bridge.exportSheet(token, file);
  need(fs.existsSync(file), '进度表导出没有落盘');
  try {
    return use(new Snapshot(file), source === true ? '插件进度表' : `${title || '用户给的进度表'}（${source}）`);
  } finally { fs.rmSync(file, { force: true }); }
}

/**
 * The progress sheet rows of these numbers, and of these 素材名称 without their number: read from a fresh export of the plugin's progress
 * sheet, or of the sheet the user linked.
 */
export async function progressLookup(bridge: Bridge, source: true | string, numbers: number[], tmpDir: string, bodies: string[] = []): Promise<{ rows: Map<number, ProgressRow[]>; named: Map<string, ProgressRow[]>; label: string }> {
  return readProgressSheet(bridge, source, tmpDir, (snapshot, label) => {
    const found = lookupRows(snapshot, numbers, bodies);
    return { rows: found.byNumber, named: found.byBody, label };
  });
}

/**
 * `gof creative rows`: the progress sheet rows of the given numbers and those whose 素材名称 or 提炼词 contains one of the texts, for
 * working out which row each file is before planning. Reads only.
 */
export async function findRows(bridge: Bridge, query: { numbers: number[]; texts: string[]; progress?: true | string }, deps: UploadDeps = {}): Promise<Obj> {
  need(query.numbers.length > 0 || query.texts.length > 0, 'rows 需要 --numbers 或 --find');
  return readProgressSheet(bridge, query.progress ?? true, deps.tmpDir ?? resolveDataPaths().tmp, (snapshot, label) => {
    const { rows, not_found, more } = searchProgressRows(snapshot, query.numbers, query.texts);
    return {
      status: 'progress_rows', source: label, count: rows.length,
      rows: rows.map(r => ({
        number: r.number, name: r.name, keyword: r.keyword, head_reference: r.head_reference, creative_reference: r.creative_reference,
        primary_tag: r.primary_tag, secondary_tag: r.secondary_tag, creative_form: r.creative_form, supplier: r.supplier, reviewer: r.reviewer,
        where: `${r.sheet} 第 ${r.row} 行`,
      })),
      ...(not_found.length ? { not_found } : {}), ...(more ? { more } : {}),
    };
  });
}

/** The zips among the given files (or directly inside a given folder), unpacked: zip path → its folder, and what inside cannot go up. */
async function unpackArchives(inputs: string[], root: string): Promise<{ unpacked: Map<string, string>; skipped: Skipped[] }> {
  const zips: string[] = [];
  for (const input of inputs) {
    const full = path.resolve(input);
    const stat = fs.statSync(full, { throwIfNoEntry: false });
    if (stat?.isFile() && isZip(full)) zips.push(full);
    else if (stat?.isDirectory()) for (const entry of fs.readdirSync(full, { withFileTypes: true })) if (entry.isFile() && isZip(entry.name)) zips.push(path.join(full, entry.name));
  }
  const unpacked = new Map<string, string>();
  const skipped: Skipped[] = [];
  for (const zip of zips) {
    const result = await unpackZip(zip, root, materialRefusal);
    unpacked.set(zip.toLowerCase(), result.dir);
    skipped.push(...result.skipped);
  }
  return { unpacked, skipped };
}

/** The files behind what the user gave, zips unpacked into this user's tmp (a folder reaches lark-agent only as a zip), and what cannot go up. */
async function gather(inputs: string[], deps: UploadDeps): Promise<{ materials: ReturnType<typeof scanMaterials>['materials']; skipped: Skipped[] }> {
  const archives = await unpackArchives(inputs, path.join(deps.tmpDir ?? resolveDataPaths().tmp, UNPACKED));
  const scanned = scanMaterials(inputs, archives.unpacked);
  return { materials: scanned.materials, skipped: [...scanned.skipped, ...archives.skipped] };
}

/**
 * `gof creative files`: what the given files, folders and zips hold, file by file, for planning from the files themselves before their rows
 * exist (a file named GOFCNxxxxx_<name> is made for the row that will be called GOFCN<number>_<name>). Reads only, offline.
 */
export async function listFiles(inputs: string[], deps: UploadDeps = {}): Promise<Obj> {
  const { materials, skipped } = await gather(inputs, deps);
  return {
    status: 'files', count: materials.length,
    files: materials.map(m => {
      const pending = pendingBody(m.name);
      return { file: m.origin ?? m.file_name, path: m.file, name: m.name, kind: m.kind, size: m.size,
        ...(m.number !== null ? { number: m.number } : {}),
        ...(pending !== null ? { pending_number: true, name_without_number: pending, parts: nameParts(pending) } : {}) };
    }),
    ...(skipped.length ? { skipped: skipped.map(s => ({ file: shownFile(s.file), reason: s.reason })) } : {}),
  };
}

/** Reads the request, the files and what CLS offers, and writes the sealed plan the user approves. Sends nothing. */
export async function planUpload(online: Online, bridge: Bridge | undefined, requestFile: string, output: string, deps: UploadDeps = {}): Promise<Obj> {
  const file = path.resolve(output);
  need(!fs.existsSync(file), '计划文件已存在，不覆盖');
  const request: UploadRequest = normalizeUploadRequest(readJson(requestFile));
  const { materials, skipped } = await gather(request.files, deps);
  const hashed = [];
  for (const material of materials) {
    const { sha256, md5, size } = await hashFile(material.file);
    need(size === material.size, `读取期间文件大小变化：${material.file}`);
    hashed.push({ ...material, sha256, md5 });
  }
  const session = await online.session();
  const api = adapterFor(session, deps);
  const options = await readOptions(api, session);
  let progress: Map<number, ProgressRow[]> | undefined;
  let named: Map<string, ProgressRow[]> | undefined;
  let progressSource: string | undefined;
  if (request.progress) {
    need(bridge, '这个环境不能读飞书进度表');
    // Every row a file may be: the one the request names for it, the one its file name's number points at, and for a file named
    // GOFCNxxxxx_<name>, the one named GOFCN<number>_<name>.
    const numbers = [...new Set([...(request.items ?? []).map(i => i.number), ...hashed.map(m => m.number)].filter((n): n is number => typeof n === 'number'))];
    const bodies = [...new Set(hashed.map(m => pendingBody(m.name)).filter((b): b is string => b !== null))];
    const lookup = await progressLookup(bridge, request.progress, numbers, deps.tmpDir ?? resolveDataPaths().tmp, bodies);
    progress = lookup.rows;
    named = lookup.named;
    progressSource = lookup.label;
  }
  const input = { request, options, materials: hashed, skipped, existing: new Set<string>(), ...(progress ? { progress } : {}), ...(named ? { named } : {}), ...(progressSource ? { progressSource } : {}), ...(deps.now ? { now: deps.now() } : {}) };
  // The names come out of the plan itself (a file may be renamed), so they are known only after a first pass.
  const first = buildUploadPlan(input);
  const existing = await existingNames(api, options.game.id, first.items.map((i: Obj) => i.name));
  const plan = existing.size ? buildUploadPlan({ ...input, existing }) : first;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeJsonNew(file, plan);
  return uploadPlanSummary(plan, file);
}

// ---- the run ------------------------------------------------------------------------------------------------------------------

function batchOf(plan: Obj, deps: UploadDeps): string {
  const root = deps.batchRoot ?? resolveDataPaths().batches;
  return path.join(root, `upload-${String(plan.plan_id).slice(0, 24)}`);
}

/** Opens (or starts) the batch of an approved plan: the batch holds its own copy of the plan, and only that plan's. */
function openBatch(plan: Obj, deps: UploadDeps): string {
  const dir = batchOf(plan, deps);
  const copy = path.join(dir, 'plan.json');
  if (fs.existsSync(copy)) {
    need(loadUploadPlan(copy).plan_id === plan.plan_id, '上传批次目录与计划不符');
  } else {
    fs.mkdirSync(dir, { recursive: true });
    writeJsonNew(copy, plan);
    appendUploadEvent(dir, 'started', { plan_id: plan.plan_id, files: plan.items.length }, deps.now);
  }
  return dir;
}

/** The plan's people, directories and types must still be on offer, and the account still able to upload. */
function stillOffered(plan: Obj, options: UploadOptions): void {
  need(options.can_upload, 'CLS 账号已没有上传创意的权限');
  need(options.game.id === plan.game.id, 'GOFCN 项目变化');
  const dirs = new Set(flattenDirectories(options.directories).map(d => d.id));
  const creators = new Set(options.creators.map(p => p.id));
  const producers = new Set(options.producers.map(p => p.id));
  const types = new Set(options.types.map(t => t.id));
  for (const item of plan.items) {
    need(dirs.has(item.directory.id), `上传目录已不存在：${item.directory.path}`);
    need(creators.has(item.creator.id), `创意人已不可选：${item.creator.name}`);
    for (const p of item.producers) need(producers.has(p.id), `制作人已不可选：${p.name}`);
    need(types.has(item.type.id), `素材类型已不可选：${item.type.name}`);
  }
}

const sameIds = (a: number[], b: number[]) => a.length === b.length && [...a].sort((x, y) => x - y).every((v, i) => v === [...b].sort((x, y) => x - y)[i]);

/** What CLS now says about one created creative, against the plan item it was made from. */
function check(detail: Obj, item: Obj, name: string, account: number): Obj {
  const problems: string[] = [];
  if (detail?.name !== name) problems.push('名称');
  if (detail?.upload_user_id !== account) problems.push('上传人');
  if (detail?.user_id !== item.creator.id) problems.push('创意人');
  if (!Array.isArray(detail?.user_ids) || !sameIds(detail.user_ids, item.producers.map((p: Obj) => p.id))) problems.push('制作人');
  const types = detail?.params?.types;
  if (!Array.isArray(types) || types.length !== 1 || types[0] !== item.type.id) problems.push('素材类型');
  if (detail?.adsdesk_dir_id !== item.directory.id) problems.push('上传目录');
  const material = Array.isArray(detail?.materials) ? detail.materials[0] : undefined;
  if (material?.file_hash && material.file_hash !== item.md5) problems.push('文件内容');
  return { ok: problems.length === 0, problems, annotated: !['创意人', '制作人', '素材类型'].some(p => problems.includes(p)), processing: !material };
}

/**
 * What a create of unknown outcome made: creatives of the exact name, uploaded by this account (confirmed or 待确认), whose material is the
 * approved file. CLS takes a file (by its MD5) only once, so that one is this batch's; another of the same name (made by hand on the page
 * meanwhile, say) is not, and is never annotated. A material CLS has not processed yet shows no hash: it is looked at again later.
 */
async function findCreated(api: CreativeAdapter, gameId: number, account: number, wanted: [string, Obj][]): Promise<Map<string, number>> {
  const found = new Map<string, number>();
  for (const [name, item] of wanted) {
    for (const confirmed of [true, false]) {
      const data = await api.search(gameId, name, confirmed);
      const hits = (data?.creatives ?? []).filter((c: Obj) => c.name === name && c.upload_user_id === account);
      const ours: number[] = [];
      for (const hit of hits) {
        const material = (await api.creative(hit.id))?.materials?.[0];
        if (material?.file_hash === item.md5) ours.push(hit.id);
      }
      if (ours.length === 1) found.set(name, ours[0]!);
    }
  }
  return found;
}

function lastData(events: { step: string; data: Obj }[], step: string): Obj | undefined {
  return [...events].reverse().find(e => e.step === step)?.data;
}

const CHUNK_FILES = 20;
const CHUNK_BYTES = 2 * 1024 ** 3;

/** Groups of files signed and put together, so that each group's links are fresh when its files go up. */
function chunks(items: Obj[]): Obj[][] {
  const out: Obj[][] = [];
  let current: Obj[] = [];
  let bytes = 0;
  for (const item of items) {
    if (current.length && (current.length >= CHUNK_FILES || bytes + item.size > CHUNK_BYTES)) { out.push(current); current = []; bytes = 0; }
    current.push(item);
    bytes += item.size;
  }
  if (current.length) out.push(current);
  return out;
}

/**
 * Runs an approved plan to the end, or goes on with it: file check, sign, put, create (once), annotate, read back. The result says what
 * exists in CLS now; `status` is `uploaded` when every planned file is a creative with its annotation, `partial` when some are not (with
 * the reason), `unknown` when a create's outcome could not be found out yet, `blocked` when nothing more can be done without the user.
 */
export async function runUpload(online: Online, planFile: string, deps: UploadDeps = {}): Promise<Obj> {
  const plan = loadUploadPlan(planFile);
  const dir = openBatch(plan, deps);
  const record = (step: string, data: Obj = {}) => appendUploadEvent(dir, step, data, deps.now);
  const sleep = deps.sleep ?? pause;
  const session = await online.session();
  need(session.account.id === plan.account.id, `当前登录的 CLS 账号“${session.account.name}”不是计划里的“${plan.account.name}”`);
  const createMarker = path.join(dir, 'create-sent.json');
  // The create goes out once per batch, whatever happens to this process: the marker is made (exclusively) right before it is sent.
  // An annotation only sets values, so its record in the journal is all it needs.
  const api = adapterFor(session, deps, {
    beforeWrite: apiPath => {
      if (!apiPath.includes('multiple-upload')) return;
      try { writeJsonNew(createMarker, { plan_id: plan.plan_id, at: (deps.now?.() ?? new Date()).toISOString() }); }
      catch { throw new ClsError('这个批次已经发出过创建请求；先回读核对，不重发', 'unknown'); }
    },
  });
  const gameId: number = plan.game.id;
  const items: Obj[] = plan.items;

  if (!fs.existsSync(createMarker)) {
    // Nothing has been created yet: everything up to the create can be done (again) from the start.
    for (const item of items) {
      const stat = fs.statSync(item.file, { throwIfNoEntry: false });
      need(stat?.isFile() && stat.size === item.size, `文件在批准后不见了或变了：${item.file}`);
      need((await hashFile(item.file)).sha256 === item.sha256, `文件在批准后被改过：${item.file}`);
    }
    stillOffered(plan, await readOptions(api, session));
    const clash = await existingNames(api, gameId, items.map(i => i.name));
    need(clash.size === 0, `CLS 现在已有同名创意：${[...clash].join('、')}；请改名后重新做计划`);
    const mapped = new Map<string, string>();
    const finished: string[] = [];
    for (const group of chunks(items)) {
      // The page signs "<creative name>/<file name>"; a file the plan renames goes up under its new name.
      const keys = group.map(i => `${i.name}/${i.upload_name ?? i.file_name}`);
      const signed = await api.sign(gameId, keys);
      const byKey = new Map(signed.files.map(f => [f.key, f]));
      const missing = keys.filter(k => !byKey.has(k));
      need(missing.length === 0, `CLS 没有给这些文件上传链接（格式不受支持）：${missing.join('、')}`);
      record('signed', { keys, objects: signed.files.map(f => f.object), mapping: signed.mapping });
      await api.log(`${session.account.name}获取预签名链接: ${JSON.stringify(keys)}（requirement-auto）`);
      for (const item of group) {
        const key = `${item.name}/${item.upload_name ?? item.file_name}`;
        let link = byKey.get(key)!;
        let receipt: Obj | undefined;
        for (let attempt = 1; !receipt; attempt++) {
          // A link about to run out (or one that failed) is asked for again: nothing is made of a link until the create.
          if (attempt > 1 || (link.expires_at !== undefined && link.expires_at * 1000 - Date.now() < 5 * 60_000)) {
            const again = await api.sign(gameId, [key]);
            const fresh = again.files.find(f => f.key === key);
            need(fresh, `CLS 没有再给 ${item.file_name} 上传链接`);
            link = fresh;
            signed.mapping[key] = again.mapping[key]!;
            record('signed', { keys: [key], objects: [fresh.object], mapping: { [key]: again.mapping[key] } });
          }
          try { receipt = await api.put(key, item.file, item.size); } catch (error) {
            if (attempt >= 3) throw error;
            await sleep(2_000 * attempt);
          }
        }
        record('uploaded', { key, object: link.object, ...receipt });
        finished.push(key);
        mapped.set(item.name, signed.mapping[key]!.split('/')[0]!);
      }
    }
    await api.log(`成功上传以下文件至游戏: ${plan.game.name}; 文件列表: ${JSON.stringify(finished)}（requirement-auto）`);
    const names = items.map(i => mapped.get(i.name)!);
    const directories = Object.fromEntries(items.map(i => [mapped.get(i.name)!, i.directory.id]));
    record('create_attempt', { names, directories, renamed: items.filter(i => mapped.get(i.name) !== i.name).map(i => ({ from: i.name, to: mapped.get(i.name) })) });
    try {
      const created = await api.createCreatives(gameId, names, directories);
      record('created', created);
    } catch (error) {
      if (!(error instanceof ClsError)) throw error;
      record(error.kind === 'unknown' ? 'create_unknown' : 'create_refused', { reason: error.message });
    }
  }

  // From here on the create has been sent once and is never sent again.
  let events = uploadEvents(dir);
  const attempt = lastData(events, 'create_attempt');
  if (!attempt) {
    // The attempt is recorded before the marker is made, so a marker without one means the batch record is damaged: what went out is not known.
    return { status: 'unknown', batch: dir, reason: '批次记录不完整，创建请求是否发出无法确定；先在 CLS 创意列表里核对这些文件是否已有创意，不重发', list_url: LIST_URL };
  }
  const names: string[] = attempt.names;
  const itemOf = new Map(items.map((item, i) => [names[i]!, item]));
  const refused = lastData(events, 'create_refused');
  let ids = new Map<string, number>();
  let failed: string[] = [];
  const created = lastData(events, 'created');
  if (created) {
    for (const s of created.succ) ids.set(s.name, s.id);
    failed = created.fail;
  } else {
    // A create whose answer was lost: look for what it made, for a while (the server may still be working on it). A refused one is
    // looked at once, since a refusal does not prove that nothing was made.
    const tries = refused ? 1 : deps.reconcileTries ?? 4;
    for (let i = 0; i < tries; i++) {
      ids = await findCreated(api, gameId, plan.account.id, names.map(name => [name, itemOf.get(name)!]));
      if (ids.size === names.length) break;
      if (i < tries - 1) await sleep(15_000);
    }
    record('reconciled', { found: Object.fromEntries(ids), missing: names.filter(n => !ids.has(n)) });
    events = uploadEvents(dir);
    if (refused && ids.size === 0) return { status: 'blocked', batch: dir, reason: `CLS 没有创建创意：${refused.reason}`, uploaded: [] };
    if (refused) failed = names.filter(n => !ids.has(n));
  }

  // Annotation (创意人, 制作人, 素材类型) for the creatives that do not show it yet. It only sets values, so it is sent again only when a
  // read-back shows it missing, at most three times per batch; a refusal stops it.
  const readBack = async () => {
    const result = new Map<string, Obj>();
    for (const [name, id] of ids) result.set(name, check(await api.creative(id), itemOf.get(name)!, name, plan.account.id));
    return result;
  };
  let report = await readBack();
  let annotateError: string | undefined;
  for (;;) {
    const pending = [...ids].filter(([name]) => !report.get(name)!.annotated);
    if (pending.length === 0) break;
    const round = uploadEvents(dir).filter(e => e.step === 'annotate_attempt').length + 1;
    if (round > 3) { annotateError = '标注已发送 3 次仍未生效'; break; }
    record('annotate_attempt', { round, ids: pending.map(([, id]) => id) });
    try {
      await api.annotate(gameId, pending.map(([name, id]) => {
        const item = itemOf.get(name)!;
        return { id, sponsor: item.creator.id, producers: item.producers.map((p: Obj) => p.id), types: [item.type.id] };
      }));
      record('annotated', { round, ids: pending.map(([, id]) => id) });
    } catch (error) {
      if (!(error instanceof ClsError)) throw error;
      record('annotate_failed', { round, reason: error.message, unknown: error.kind === 'unknown' });
      if (error.kind !== 'unknown') annotateError = error.message;
    }
    report = await readBack();
    if (annotateError) break;
    if (round < 3 && [...ids].some(([name]) => !report.get(name)!.annotated)) await sleep(2_000);
  }

  // The AdsDesk sync the directory triggers, as the list shows it.
  const sync = new Map<number, Obj>();
  try {
    const mine = await api.mine(gameId, plan.account.id, Math.min(100, Math.max(20, ids.size + 10)));
    for (const c of mine?.creatives ?? []) sync.set(c.id, c.sync_status?.adsdesk ?? {});
  } catch { /* the sync state is extra information */ }
  const adsdesk = (id: number) => { const s = sync.get(id); return !s ? '未知' : s.fail > 0 ? '同步失败' : s.status === 1 && s.succ >= s.total ? '已同步' : '同步中'; };

  const uploaded = [...ids].map(([name, id]) => {
    const item = itemOf.get(name)!;
    const state = report.get(name)!;
    return { name, id, file: item.file_name, type: item.type.name, creator: item.creator.name, producers: item.producers.map((p: Obj) => p.name),
      verified: state.ok, ...(state.ok ? {} : { problems: state.problems }), ...(state.processing ? { processing: true } : {}), adsdesk: adsdesk(id) };
  });
  const notCreated = failed.map(name => ({ name, file: itemOf.get(name)?.file_name,
    reason: refused ? `CLS 拒绝创建：${refused.reason}` : 'CLS 已有内容相同的素材（MD5 重复），没有创建' }));
  const missing = names.filter(n => !ids.has(n) && !failed.includes(n)).map(name => ({ name, file: itemOf.get(name)?.file_name }));
  record('verified', { uploaded: uploaded.map(u => ({ id: u.id, name: u.name, verified: u.verified, ...(u.problems ? { problems: u.problems } : {}) })), not_created: failed, missing: missing.map(m => m.name) });
  const allGood = uploaded.length === items.length && uploaded.every(u => u.verified);
  return {
    status: allGood ? 'uploaded' : missing.length ? 'unknown' : 'partial', batch: dir, list_url: LIST_URL, uploaded,
    ...(annotateError ? { annotate_error: annotateError } : {}),
    ...(notCreated.length ? { not_created: notCreated } : {}), ...(missing.length ? { missing, reason: '创建请求的结果没能确认：这些文件在 CLS 里还没找到。稍后再运行一次本命令核对，不会重新创建' } : {}),
    ...(attempt.renamed?.length ? { renamed: attempt.renamed } : {}), ...(plan.skipped.length ? { skipped: plan.skipped.map((s: Obj) => ({ file: shownFile(s.file), reason: s.reason })) } : {}),
  };
}

/**
 * The picture of 我的创意 > 创意列表 (this account's uploads, newest first). The session is taken first, so a login that needs the
 * consent page pressed is put right before the browser is opened for the picture.
 */
export async function listPicture(online: Online, output: string, rows: number | undefined, deps: UploadDeps & { shot?: Partial<ShotOptions> } = {}): Promise<Obj> {
  const session = await online.session();
  const games = await adapterFor(session, deps).games();
  const game = (Array.isArray(games) ? games : []).find((g: Obj) => g.code === 'GOFCN');
  need(game, `CLS 账号“${session.account.name}”没有 GOFCN 项目`);
  const result = await listScreenshot({ profileDir: clsProfileDir(), output, accountId: session.account.id, game, ...(rows !== undefined ? { rows } : {}), ...deps.shot });
  if (result.state === 'login_required') throw new Blocked('CLS 登录已失效（页面停在登录页）：先运行 gof.mjs login check 再截图');
  if (result.state === 'no_access') throw new Blocked(`创意列表打不开（停在 ${result.where}）：账号可能没有这个页面的权限`);
  return { status: 'screenshot_saved', file: result.file, rows: result.rows, total: result.total, list_url: LIST_URL };
}

/** What a batch has recorded so far, from its own files only. */
export function uploadStatus(planFile: string, deps: UploadDeps = {}): Obj {
  const plan = loadUploadPlan(planFile);
  const dir = batchOf(plan, deps);
  if (!fs.existsSync(path.join(dir, 'plan.json'))) return { status: 'not_started', plan: path.resolve(planFile), files: plan.items.length };
  const events = uploadEvents(dir);
  return {
    status: 'recorded', batch: dir, files: plan.items.length, steps: events.map(e => e.step),
    create_sent: fs.existsSync(path.join(dir, 'create-sent.json')), last: events.length ? events[events.length - 1] : null,
  };
}
