import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { columnLetter } from './a1.ts';
import { matchUser } from './cls.ts';
import { checkSeal, rejectSecrets, seal } from './seal.ts';
import { concatenate, scanSheets, type Snapshot } from './snapshot.ts';
import { Blocked, digest, isObject, need, readJson, writeJsonNew } from './util.ts';

/*
 * The material upload, offline: which files go up as which creatives, with what annotation, from a request and the options CLS offers.
 * One file is one creative, named after the file without its extension, as on the page 上传创意 (a folder is read one level deep, like the
 * page's folder pick, and each file in it is its own creative). The plan made here is sealed; `gof creative run` checks the seal and the
 * files against it before anything is sent.
 */

type Obj = Record<string, any>;
export type Kind = 'video' | 'image' | 'other';

export const DEFAULT_DIRECTORY = '双端共用-视频';

/** The formats CLS hands out an upload link for (asked of the real signing call, 2026-10-21), by what they are. Others get no link. */
export const KINDS: Record<string, Kind> = {
  mp4: 'video', mov: 'video', avi: 'video', m4v: 'video',
  jpg: 'image', jpeg: 'image', png: 'image', gif: 'image', webp: 'image', bmp: 'image',
  html: 'other', mp3: 'other', wav: 'other',
};
/** 素材类型 by what the file is: a picture is 图片, a video 视频, anything else 其他. */
export const TYPE_OF_KIND: Record<Kind, string> = { video: 'video', image: 'image', other: 'other' };
const ARCHIVES = new Set(['zip', 'rar', '7z', 'tar', 'gz']);
/** One PUT to object storage carries at most this much. */
const MAX_BYTES = 5 * 1024 ** 3;
const MAX_FILES = 200;

export interface Material {
  file: string; file_name: string; size: number; mtime_ms: number; ext: string; kind: Kind;
  /** The creative name: the file name without its extension, as the page names it. */
  name: string;
  /** The GOFCN material number the name starts with or carries, if any. */
  number: number | null;
}
export interface Skipped { file: string; reason: string }

/** Characters the page strips from names (bidirectional embedding and override marks). */
const BIDI = /[\u202a-\u202d]/g;

export function creativeName(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return (dot > 0 ? fileName.slice(0, dot) : fileName).replace(BIDI, '');
}

/** The GOFCN material number in a name ("GOFCN67471_AI剧情…" → 67471); GOFCNIM… and other series are not material numbers. */
export function materialNumber(name: string): number | null {
  // At most 9 digits: GOFCN plus 11 digits is a requirement number (GOFCN20261019002), not a material.
  const m = /GOFCN(\d{1,9})(?!\d)/i.exec(name);
  return m ? Number(m[1]) : null;
}

/** Why a file by this name cannot be a material, or null when it can (the same rule for files on disk and files inside a zip). */
export function materialRefusal(fileName: string): string | null {
  if (fileName.startsWith('.')) return '隐藏文件';
  const ext = path.extname(fileName).slice(1).toLowerCase();
  if (ext === 'zip') return '压缩包里的压缩包不读取';
  if (ARCHIVES.has(ext)) return '只支持 zip 压缩包（不支持 rar、7z 等），请改成 zip';
  if (!KINDS[ext]) return `CLS 不支持这种格式（${ext ? `.${ext}` : '无扩展名'}）`;
  return null;
}

/** Is this a zip (a folder the user packed, since Feishu cannot hand over a folder)? */
export const isZip = (file: string): boolean => path.extname(file).toLowerCase() === '.zip';

/**
 * The files behind what the user gave: files as they are, a folder's files one level deep, and a zip by the files it was unpacked to
 * (`unpacked`: zip path → its unpacked folder, see unzip.ts). What cannot go up is said, not dropped.
 */
export function scanMaterials(inputs: string[], unpacked: Map<string, string> = new Map()): { materials: Material[]; skipped: Skipped[] } {
  need(Array.isArray(inputs) && inputs.length > 0, '没有要上传的文件');
  const materials: Material[] = [];
  const skipped: Skipped[] = [];
  const seen = new Set<string>();
  const consider = (file: string) => {
    const key = path.resolve(file).toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    const stat = fs.statSync(file, { throwIfNoEntry: false });
    const fileName = path.basename(file);
    if (!stat?.isFile()) return void skipped.push({ file, reason: '不是普通文件' });
    const folder = isZip(file) ? unpacked.get(key) : undefined;
    if (folder) {
      for (const entry of fs.readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) if (entry.isFile()) consider(path.join(folder, entry.name));
      return;
    }
    if (isZip(file)) return void skipped.push({ file, reason: '压缩包没有解压' });
    const refused = materialRefusal(fileName);
    if (refused) return void skipped.push({ file, reason: refused });
    const ext = path.extname(fileName).slice(1).toLowerCase();
    const kind = KINDS[ext]!;
    if (stat.size === 0) return void skipped.push({ file, reason: '空文件' });
    if (stat.size > MAX_BYTES) return void skipped.push({ file, reason: '单个文件超过 5 GB' });
    const name = creativeName(fileName);
    if (!name.trim()) return void skipped.push({ file, reason: '文件名为空' });
    materials.push({ file: path.resolve(file), file_name: fileName, size: stat.size, mtime_ms: Math.trunc(stat.mtimeMs), ext, kind, name, number: materialNumber(name) });
  };
  for (const input of inputs) {
    need(typeof input === 'string' && input.trim() !== '', 'files 里有空路径');
    const full = path.resolve(input);
    const stat = fs.statSync(full, { throwIfNoEntry: false });
    if (!stat) { skipped.push({ file: full, reason: '文件不存在' }); continue; }
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(full, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const inner = path.join(full, entry.name);
        if (entry.isDirectory()) skipped.push({ file: inner, reason: '文件夹不可嵌套，里面的文件没有读取' });
        else consider(inner);
      }
    } else consider(full);
  }
  need(materials.length <= MAX_FILES, `一次最多上传 ${MAX_FILES} 个文件，请分批`);
  return { materials, skipped };
}

/** SHA-256 (to know the approved file is the one sent) and MD5 (what CLS records as the file's hash) in one read. */
export async function hashFile(file: string): Promise<{ sha256: string; md5: string; size: number }> {
  const sha = createHash('sha256');
  const md5 = createHash('md5');
  let size = 0;
  for await (const chunk of fs.createReadStream(file)) { sha.update(chunk as Buffer); md5.update(chunk as Buffer); size += (chunk as Buffer).length; }
  return { sha256: sha.digest('hex'), md5: md5.digest('hex'), size };
}

// ---- the request --------------------------------------------------------------------------------------------------------------

export interface ItemRequest { file: string; name?: string; type?: string; creator?: string; producers?: string[]; directory?: string; skip?: boolean }
export interface UploadRequest {
  files: string[];
  directory?: string;
  creator?: string;
  producers?: string[];
  /** Take 创意人/制作人 per file from the progress sheet row of its GOFCN number: true for the plugin's progress sheet, or a sheet link. */
  progress?: boolean | string;
  items?: ItemRequest[];
}

const TOP_KEYS = ['files', 'directory', 'creator', 'producers', 'progress', 'items'];
const ITEM_KEYS = ['file', 'name', 'type', 'creator', 'producers', 'directory', 'skip'];

function text(value: unknown, label: string, max = 255): string {
  need(typeof value === 'string' && value.trim() !== '' && [...value].length <= max && !/[\r\n\t\0]/.test(value), `${label} 必须是非空的一行文字`);
  return value.trim();
}
function names(value: unknown, label: string): string[] {
  need(Array.isArray(value) && value.length > 0, `${label} 必须是至少一个名字的列表`);
  const list = value.map((v, i) => text(v, `${label}[${i}]`));
  need(new Set(list).size === list.length, `${label} 有重复`);
  return list;
}

export function normalizeUploadRequest(input: unknown): UploadRequest {
  need(isObject(input), '上传请求必须是 JSON 对象');
  const unknown = Object.keys(input).filter(k => !TOP_KEYS.includes(k));
  need(unknown.length === 0, `上传请求有未知字段：${unknown.join('、')}`);
  need(Array.isArray(input.files) && input.files.length > 0, 'files 必须列出要上传的文件或文件夹');
  const request: UploadRequest = { files: input.files.map((f: unknown, i: number) => text(f, `files[${i}]`, 1000)) };
  if (input.directory !== undefined) request.directory = text(input.directory, 'directory', 500);
  if (input.creator !== undefined) request.creator = text(input.creator, 'creator');
  if (input.producers !== undefined) request.producers = names(input.producers, 'producers');
  if (input.progress !== undefined) {
    need(input.progress === true || input.progress === false || typeof input.progress === 'string', 'progress 只能是 true/false 或进度表链接');
    if (input.progress !== false) request.progress = input.progress === true ? true : text(input.progress, 'progress', 1000);
  }
  if (input.items !== undefined) {
    need(Array.isArray(input.items), 'items 必须是列表');
    request.items = input.items.map((raw: unknown, i: number) => {
      need(isObject(raw), `items[${i}] 必须是对象`);
      const extra = Object.keys(raw).filter(k => !ITEM_KEYS.includes(k));
      need(extra.length === 0, `items[${i}] 有未知字段：${extra.join('、')}`);
      const item: ItemRequest = { file: text(raw.file, `items[${i}].file`, 1000) };
      if (raw.name !== undefined) item.name = text(raw.name, `items[${i}].name`);
      if (raw.type !== undefined) item.type = text(raw.type, `items[${i}].type`);
      if (raw.creator !== undefined) item.creator = text(raw.creator, `items[${i}].creator`);
      if (raw.producers !== undefined) item.producers = names(raw.producers, `items[${i}].producers`);
      if (raw.directory !== undefined) item.directory = text(raw.directory, `items[${i}].directory`, 500);
      if (raw.skip !== undefined) { need(typeof raw.skip === 'boolean', `items[${i}].skip 只能是 true/false`); item.skip = raw.skip; }
      return item;
    });
  }
  return request;
}

// ---- what CLS offers ----------------------------------------------------------------------------------------------------------

export interface DirNode { id: number; name: string; children?: DirNode[] }
export interface Person { id: number; name: string }
export interface UploadOptions {
  account: Person;
  game: { id: number; code: string; name: string };
  can_upload: boolean;
  directories: DirNode[];
  creators: Person[];
  producers: Person[];
  types: { id: string; name: string }[];
}

/** Every upload directory with its path from the top ("无尽冬日 - NEW / 常规素材 / 双端共用-视频"). */
export function flattenDirectories(tree: DirNode[]): { id: number; name: string; path: string }[] {
  const out: { id: number; name: string; path: string }[] = [];
  const walk = (nodes: DirNode[], trail: string[]) => {
    for (const node of nodes ?? []) {
      const parts = [...trail, String(node.name)];
      out.push({ id: node.id, name: String(node.name), path: parts.join(' / ') });
      walk(node.children ?? [], parts);
    }
  };
  walk(tree, []);
  return out;
}

/** The one directory a name, a path ("常规素材/双端共用-视频", any end of the full path) or an ID means. */
export function findDirectory(tree: DirNode[], wanted: string): { id: number; path: string } {
  const all = flattenDirectories(tree);
  const want = wanted.split('/').map(s => s.trim()).filter(Boolean);
  need(want.length > 0, '上传目录为空');
  const found = /^\d+$/.test(wanted.trim())
    ? all.filter(d => d.id === Number(wanted.trim()))
    : all.filter(d => { const parts = d.path.split(' / '); return want.every((w, i) => parts[parts.length - want.length + i] === w); });
  need(found.length > 0, `CLS 里没有上传目录“${wanted}”`);
  need(found.length === 1, `上传目录“${wanted}”不唯一（${found.slice(0, 5).map(d => d.path).join('；')}），请写出上一级目录`);
  return { id: found[0]!.id, path: found[0]!.path };
}

/**
 * The person a name means among the people the page offers: the exact name, else the short name a company name carries, else the one
 * containing it. A CLS user ID picks one of two people with the same name (the 创意人 list has two 李晨阳).
 */
function person(list: Person[], wanted: string, label: string): Person {
  if (/^\d+$/.test(wanted)) {
    const byId = list.find(p => p.id === Number(wanted));
    need(byId, `${label} 不在可选的人里`);
    return { id: byId.id, name: byId.name };
  }
  const users = list.map(p => ({ ...p, status: 1, roles: [] as string[] }));
  const found = matchUser(users, wanted, false, label);
  return { id: found.id, name: found.name };
}

/** The 素材类型 a name or ID means; without one, by what the file is. */
function materialType(types: { id: string; name: string }[], wanted: string | undefined, kind: Kind): { id: string; name: string } {
  const id = wanted ?? TYPE_OF_KIND[kind];
  const found = types.filter(t => t.id === id || t.name === id);
  need(found.length === 1, `CLS 素材类型里没有“${id}”`);
  return { id: found[0]!.id, name: found[0]!.name };
}

// ---- the plan -----------------------------------------------------------------------------------------------------------------

/** One row of the progress sheet for a material number: who supplied it (设计师供应商) and who reviewed the script (创意者脚本审核人). */
export interface ProgressRow { sheet: string; row: number; number: number; supplier: string; reviewer: string; name: string | null }

export interface PlanInput {
  request: UploadRequest;
  options: UploadOptions;
  materials: (Material & { sha256: string; md5: string })[];
  skipped: Skipped[];
  /** Rows of the progress sheet by material number, when the request asked for them. */
  progress?: Map<number, ProgressRow[]>;
  progressSource?: string;
  /** Names CLS already has a creative of (its signing refuses the whole batch for any of them). */
  existing: Set<string>;
  now?: Date;
}

/** Names of several people in one sheet cell (the supplier column is a multiple choice). */
export const splitNames = (value: string): string[] => value.split(/[,，、;；\n]/).map(s => s.trim()).filter(Boolean);

/**
 * The progress sheet rows of the wanted material numbers, from every usable GOFCN tab: who supplied the material and who reviewed its
 * script, and the material name (worked out from the naming formula where the cell holds one).
 */
export function progressRowsFrom(snapshot: Snapshot, numbers: Iterable<number>): Map<number, ProgressRow[]> {
  const wanted = new Set(numbers);
  const found = new Map<number, ProgressRow[]>();
  if (wanted.size === 0) return found;
  const { tables } = scanSheets(snapshot);
  for (const [sheet, cols] of Object.entries(tables)) {
    const ws = snapshot.sheet(sheet);
    for (let row = 2; row <= snapshot.last[sheet]!; row++) {
      const raw = snapshot.cell(sheet, row, cols.number!)?.value;
      if (!raw || !/^\d+$/.test(raw) || !wanted.has(Number(raw))) continue;
      const cellText = (col: number | undefined) => { const value = col ? snapshot.cell(sheet, row, col)?.value : null; return typeof value === 'string' ? value.trim() : ''; };
      let name: string | null = cellText(cols.name) || null;
      if (name?.startsWith('=')) {
        const values: Record<string, string | number | null> = {};
        for (let col = 1; col <= ws.maxCol; col++) {
          const cell = snapshot.cell(sheet, row, col);
          values[`${columnLetter(col)}${row}`] = cell?.value === undefined || cell?.value === null ? null : cell.kind === 'n' ? Number(cell.value) : cell.value;
        }
        try { name = concatenate(name, values); } catch { name = null; }
      }
      const entry: ProgressRow = { sheet, row, number: Number(raw), supplier: cellText(cols.supplier), reviewer: cellText(cols.creator), name };
      found.set(entry.number, [...(found.get(entry.number) ?? []), entry]);
    }
  }
  return found;
}

/** Problems grouped by what is wrong, each with the files it concerns ("创意人未定：a.mp4、b.mp4 等 12 个文件"). */
function grouped(problems: { reason: string; file?: string }[]): string {
  const byReason = new Map<string, string[]>();
  for (const p of problems) byReason.set(p.reason, [...(byReason.get(p.reason) ?? []), ...(p.file ? [p.file] : [])]);
  return [...byReason].map(([reason, files]) => files.length === 0 ? reason
    : `${reason}：${files.slice(0, 5).join('、')}${files.length > 5 ? ` 等 ${files.length} 个文件` : ''}`).join('；');
}

export function buildUploadPlan(input: PlanInput): Obj {
  const { request, options, materials, existing } = input;
  need(options.can_upload, `CLS 账号“${options.account.name}”在 ${options.game.code} 没有上传创意的权限`);
  const problems: { reason: string; file?: string }[] = [];
  const skipped = [...input.skipped];
  const byFile = new Map<string, ItemRequest>();
  for (const item of request.items ?? []) {
    const matches = materials.filter(m => m.file_name === item.file || m.file === path.resolve(item.file) || m.name === item.file);
    if (matches.length !== 1) { problems.push({ reason: `items 里的“${item.file}”${matches.length ? '对应多个文件' : '不在要上传的文件里'}` }); continue; }
    byFile.set(matches[0]!.file, item);
  }
  const defaultDirectory = findDirectory(options.directories, request.directory ?? DEFAULT_DIRECTORY);
  const items: Obj[] = [];
  const named = new Map<string, string>();
  for (const material of materials) {
    const item = byFile.get(material.file) ?? { file: material.file_name };
    if (item.skip) { skipped.push({ file: material.file, reason: '按要求不上传' }); continue; }
    const label = material.file_name;
    // Every name is checked, whatever else is wrong with the file, so that the user hears of all of it at once.
    const name = (item.name ?? material.name).replace(BIDI, '');
    const key = name.toLowerCase();
    if (named.has(key)) problems.push({ reason: `两个文件会得到同一个创意名称“${name}”（${named.get(key)}、${label}），请改名或只留一个` });
    else named.set(key, label);
    if (existing.has(name)) problems.push({ reason: 'CLS 已有同名创意（CLS 会拒绝整批上传），请改名或不上传', file: name });
    try {
      need(!/[\\/]/.test(name), '创意名称不能含 / 或 \\');
      const directory = item.directory ? findDirectory(options.directories, item.directory) : defaultDirectory;
      const type = materialType(options.types, item.type, material.kind);
      // 创意人 / 制作人: the file's own setting, then the request's, then the progress sheet row of the file's number.
      let row: ProgressRow | undefined;
      const fromSheet = (item.creator ?? request.creator) === undefined || (item.producers ?? request.producers) === undefined;
      if (fromSheet && input.progress) {
        need(material.number !== null, '文件名里没有 GOFCN 素材编号，对不上进度表，需要写明创意人和制作人');
        const rows = input.progress.get(material.number) ?? [];
        need(rows.length > 0, `进度表里没有 GOFCN${material.number}，需要写明创意人和制作人`);
        need(rows.length === 1, `进度表里 GOFCN${material.number} 有 ${rows.length} 行（${rows.map(r => `${r.sheet} 第 ${r.row} 行`).join('、')}），需要写明创意人和制作人`);
        row = rows[0]!;
      }
      const creatorName = item.creator ?? request.creator ?? row?.reviewer;
      const producerNames = item.producers ?? request.producers ?? (row ? splitNames(row.supplier) : undefined);
      need(creatorName && creatorName.trim(), `创意人未定${row ? `（进度表 GOFCN${row.number} 的创意者脚本审核人为空）` : ''}`);
      need(producerNames && producerNames.length > 0, `制作人未定${row ? `（进度表 GOFCN${row.number} 的设计师供应商为空）` : ''}`);
      const creator = person(options.creators, creatorName, `创意人“${creatorName}”`);
      const producers = producerNames.map(n => person(options.producers, n, `制作人“${n}”`));
      need(new Set(producers.map(p => p.id)).size === producers.length, '制作人重复');
      const source = {
        creator: item.creator !== undefined ? 'item' : request.creator !== undefined ? 'request' : 'progress',
        producers: item.producers !== undefined ? 'item' : request.producers !== undefined ? 'request' : 'progress',
        ...(row ? { progress_row: { sheet: row.sheet, row: row.row, number: row.number, name: row.name, supplier: row.supplier, reviewer: row.reviewer } } : {}),
      };
      items.push({
        file: material.file, file_name: material.file_name, size: material.size, mtime_ms: material.mtime_ms, sha256: material.sha256, md5: material.md5,
        kind: material.kind, name, number: material.number, type, directory, creator, producers, source,
      });
    } catch (error) {
      if (!(error instanceof Blocked)) throw error;
      problems.push({ reason: error.message, file: label });
    }
  }
  need(items.length > 0 || problems.length > 0, '没有可上传的文件' + (skipped.length ? `：${skipped.map(s => `${path.basename(s.file)}（${s.reason}）`).join('；')}` : ''));
  if (problems.length) throw new Blocked(grouped(problems));
  return seal({
    schema: 1, kind: 'creative_upload', created_at: (input.now ?? new Date()).toISOString(),
    account: options.account, game: options.game, items, skipped,
    ...(input.progressSource ? { progress_source: input.progressSource } : {}),
  }, 'plan_id');
}

export function loadUploadPlan(file: string): Obj {
  const plan = readJson(file);
  need(plan?.schema === 1 && plan.kind === 'creative_upload' && Array.isArray(plan.items) && plan.items.length > 0, '不是上传计划文件');
  checkSeal(plan, 'plan_id');
  return plan;
}

/** A skipped file as the user knows it: a file on disk by its name, an entry of a zip as "素材.zip：子文件夹/a.mp4". */
export const shownFile = (file: string): string => (path.isAbsolute(file) ? path.basename(file) : file);

/** What the user is shown before approving: counts by type, creator and producer, the directory, and each file in short. */
export function uploadPlanSummary(plan: Obj, file: string, limit = 40): Obj {
  const count = (values: string[]) => values.reduce<Record<string, number>>((acc, v) => ({ ...acc, [v]: (acc[v] ?? 0) + 1 }), {});
  const items: Obj[] = plan.items;
  return {
    status: 'upload_plan', plan: file, count: items.length,
    directories: count(items.map(i => i.directory.path)),
    types: count(items.map(i => i.type.name)),
    creators: count(items.map(i => i.creator.name)),
    producers: count(items.map(i => i.producers.map((p: Person) => p.name).join('、'))),
    ...(plan.progress_source ? { progress_source: plan.progress_source } : {}),
    items: items.slice(0, limit).map(i => ({
      file: i.file_name, name: i.name, type: i.type.name, creator: i.creator.name, producers: i.producers.map((p: Person) => p.name),
      ...(i.source.progress_row ? { progress_row: `${i.source.progress_row.sheet} 第 ${i.source.progress_row.row} 行${i.source.progress_row.name ? `（${i.source.progress_row.name}）` : ''}` } : {}),
    })),
    ...(items.length > limit ? { more_items: items.length - limit } : {}),
    ...(plan.skipped.length ? { skipped: plan.skipped.map((s: Skipped) => ({ file: shownFile(s.file), reason: s.reason })) } : {}),
  };
}

// ---- the batch journal --------------------------------------------------------------------------------------------------------

export interface UploadEvent { step: string; data: Obj; time: string; previous: string; event_id: string }

/** The events of an upload batch, in order, each chained to the one before: a missing, reordered or edited event is refused. */
export function uploadEvents(dir: string): UploadEvent[] {
  const folder = path.join(dir, 'events');
  if (!fs.existsSync(folder)) return [];
  const files = fs.readdirSync(folder).filter(f => f.endsWith('.json')).sort();
  const records: UploadEvent[] = [];
  let previous = '';
  files.forEach((file, offset) => {
    need(file === `${String(offset + 1).padStart(6, '0')}.json`, '上传批次记录缺失或顺序异常');
    const { event_id: token, ...event } = readJson(path.join(folder, file));
    need(event.previous === previous && digest(event) === token, '上传批次记录被修改');
    records.push({ ...event, event_id: token } as UploadEvent);
    previous = token;
  });
  return records;
}

export function appendUploadEvent(dir: string, step: string, data: Obj = {}, now: () => Date = () => new Date()): UploadEvent {
  rejectSecrets(data);
  const records = uploadEvents(dir);
  const event: Obj = { step, data, time: now().toISOString(), previous: records.length ? records[records.length - 1]!.event_id : '' };
  event.event_id = digest(event);
  fs.mkdirSync(path.join(dir, 'events'), { recursive: true });
  writeJsonNew(path.join(dir, 'events', `${String(records.length + 1).padStart(6, '0')}.json`), event);
  return event as UploadEvent;
}
