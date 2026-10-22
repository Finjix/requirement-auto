import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { columnLetter } from './a1.ts';
import { matchUser } from './cls.ts';
import { checkSeal, rejectSecrets, seal } from './seal.ts';
import { scanSheets, type Columns, type Snapshot } from './snapshot.ts';
import type { SheetData } from './xlsx.ts';
import { Blocked, digest, isObject, need, readJson, writeJsonNew } from './util.ts';

/*
 * The material upload, offline: which files go up as which creatives, with what annotation, from a request and the options CLS offers.
 * One file is one creative, as on the page 上传创意 (a folder is read one level deep, like the page's folder pick, and each file in it is
 * its own creative). Its name is the 素材名称 of the file's row in the progress sheet: the row the request names for the file, else the
 * one the GOFCN number in the file name points at. A file named otherwise goes up renamed (creative and uploaded file alike); the file on
 * disk is left as it is. Without the progress sheet (`"progress": false`) the name is the file name without its extension. The plan made
 * here is sealed; `gof creative run` checks the seal and the files against it before anything is sent.
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

export interface ItemRequest {
  file: string;
  /** The GOFCN material number of the progress sheet row this file is (worked out from the requirement when the file name does not say). */
  number?: number;
  /** A name of the file's own, only without the progress sheet. */
  name?: string;
  type?: string; creator?: string; producers?: string[]; directory?: string; skip?: boolean;
}
export interface UploadRequest {
  files: string[];
  directory?: string;
  creator?: string;
  producers?: string[];
  /**
   * Where each file's row is looked up, which names the creative (素材名称) and, unless given, 创意人/制作人: true (the default) for the
   * plugin's progress sheet, or a sheet link; false only for materials that are not on a progress sheet, which keep their file names.
   */
  progress?: boolean | string;
  items?: ItemRequest[];
}

const TOP_KEYS = ['files', 'directory', 'creator', 'producers', 'progress', 'items'];
const ITEM_KEYS = ['file', 'number', 'name', 'type', 'creator', 'producers', 'directory', 'skip'];

/** A material number as a request or a command line gives it: 67680, "67680" or "GOFCN67680". */
export function numberOf(value: unknown, label: string): number {
  // At most 9 digits, as in materialNumber: GOFCN plus 11 digits is a requirement number, not a material.
  const m = /^\s*(?:GOFCN)?(\d{1,9})\s*$/i.exec(typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : typeof value === 'string' ? value : '');
  need(m && Number(m[1]) > 0, `${label} 必须是 GOFCN 素材编号（如 67680 或 GOFCN67680）`);
  return Number(m[1]);
}

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
  need(input.progress === undefined || input.progress === true || input.progress === false || typeof input.progress === 'string', 'progress 只能是 true/false 或进度表链接');
  request.progress = input.progress === undefined || input.progress === true ? true : input.progress === false ? false : text(input.progress, 'progress', 1000);
  if (input.items !== undefined) {
    need(Array.isArray(input.items), 'items 必须是列表');
    request.items = input.items.map((raw: unknown, i: number) => {
      need(isObject(raw), `items[${i}] 必须是对象`);
      const extra = Object.keys(raw).filter(k => !ITEM_KEYS.includes(k));
      need(extra.length === 0, `items[${i}] 有未知字段：${extra.join('、')}`);
      const item: ItemRequest = { file: text(raw.file, `items[${i}].file`, 1000) };
      if (raw.number !== undefined) item.number = numberOf(raw.number, `items[${i}].number`);
      if (raw.name !== undefined) item.name = text(raw.name, `items[${i}].name`);
      need(request.progress === false || item.name === undefined,
        `items[${i}].name：按进度表上传时名称就是那一行的素材名称，不能另起；用 items[${i}].number 写明这个文件是进度表的哪一行`);
      need(request.progress !== false || item.number === undefined, `items[${i}].number 只在按进度表上传时有用（progress 不能是 false）`);
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

/** A refusal of `pick` with a hint added at its end. */
function withHint<T>(pick: () => T, hint: string): T {
  try { return pick(); } catch (error) {
    if (error instanceof Blocked && hint) throw new Blocked(`${error.message}${hint}`);
    throw error;
  }
}

/** The 素材类型 a name or ID means; without one, by what the file is. */
function materialType(types: { id: string; name: string }[], wanted: string | undefined, kind: Kind): { id: string; name: string } {
  const id = wanted ?? TYPE_OF_KIND[kind];
  const found = types.filter(t => t.id === id || t.name === id);
  need(found.length === 1, `CLS 素材类型里没有“${id}”`);
  return { id: found[0]!.id, name: found[0]!.name };
}

// ---- the plan -----------------------------------------------------------------------------------------------------------------

/**
 * One row of the progress sheet: its material number and 素材名称 (worked out from the naming formula where the cell holds one; null when
 * it cannot be), who supplied it (设计师供应商) and who reviewed the script (创意者脚本审核人), and what helps tell rows apart: 提炼词,
 * the 片头/创意引用 numbers of the material it builds on, the tags and the 创意形式.
 */
export interface ProgressRow {
  sheet: string; row: number; number: number; name: string | null; supplier: string; reviewer: string;
  keyword: string; head_reference: string; creative_reference: string; primary_tag: string; secondary_tag: string; creative_form: string;
}

export interface PlanInput {
  request: UploadRequest;
  options: UploadOptions;
  materials: (Material & { sha256: string; md5: string })[];
  skipped: Skipped[];
  /** Rows of the progress sheet by material number (every number the request or a file name gives), unless `"progress": false`. */
  progress?: Map<number, ProgressRow[]>;
  progressSource?: string;
  /** Names CLS already has a creative of (its signing refuses the whole batch for any of them). */
  existing: Set<string>;
  now?: Date;
}

/** Names of several people in one sheet cell (the supplier column is a multiple choice). */
export const splitNames = (value: string): string[] => value.split(/[,，、;；\n]/).map(s => s.trim()).filter(Boolean);

class Unsupported extends Error {}

/**
 * The text a naming formula gives, the way the sheet shows it: CONCATENATE / CONCAT of texts, numbers and cells (an empty argument is an
 * empty text), inside any number of SUBSTITUTE(…, "old", "new"). The progress sheet holds all of these ("…,D22487,,L22487)",
 * SUBSTITUTE(CONCATENATE(…),"__","_"), a cell of the row above); anything else, or a cell that is itself a formula, gives null. Feishu's
 * export carries no computed values, so this is the only way to know a row's 素材名称.
 */
export function formulaText(formula: string, valueAt: (coord: string) => string | null): string | null {
  if (!formula.startsWith('=')) return null;
  const src = formula.slice(1);
  let i = 0;
  const space = () => { while (i < src.length && /\s/.test(src[i]!)) i++; };
  const fail = (): never => { throw new Unsupported(); };
  const expr = (): string => {
    space();
    if (src[i] === '"') {
      let out = '';
      for (i++; ; i++) {
        if (i >= src.length) fail();
        if (src[i] !== '"') { out += src[i]; continue; }
        if (src[i + 1] !== '"') { i++; return out; }
        out += '"';
        i++;
      }
    }
    const rest = src.slice(i);
    const call = /^([A-Za-z][A-Za-z0-9.]*)\s*\(/.exec(rest);
    if (call) {
      i += call[0].length;
      const args: string[] = [];
      space();
      if (src[i] === ')') i++;
      else for (;;) {
        space();
        args.push(src[i] === ',' || src[i] === ')' ? '' : expr());
        space();
        if (src[i] === ',') { i++; continue; }
        if (src[i] === ')') { i++; break; }
        fail();
      }
      const fn = call[1]!.toUpperCase();
      if (fn === 'CONCATENATE' || fn === 'CONCAT') return args.join('');
      if (fn === 'SUBSTITUTE' && args.length === 3 && args[1] !== '') return args[0]!.replaceAll(args[1]!, args[2]!);
      return fail();
    }
    const ref = /^\$?([A-Za-z]{1,3})\$?(\d+)(?![\w:(])/.exec(rest);
    if (ref) {
      i += ref[0].length;
      return valueAt(`${ref[1]!.toUpperCase()}${ref[2]}`) ?? fail();
    }
    const num = /^\d+(?:\.\d+)?(?![\w:])/.exec(rest);
    if (num) { i += num[0].length; return String(Number(num[0])); }
    return fail();
  };
  try {
    const out = expr();
    space();
    return i === src.length ? out : null;
  } catch (error) {
    if (error instanceof Unsupported) return null;
    throw error;
  }
}

/** A cell as the sheet shows it, as text: a number in its plain form, a formula by what it gives (see formulaText), '' when empty. */
function shownText(ws: SheetData, coord: string, depth = 0): string | null {
  const cell = ws.cells.get(coord);
  if (!cell || cell.value === null || cell.value === '') return '';
  if (cell.kind === 'n') return String(Number(cell.value));
  if (cell.kind === 's') return cell.value;
  if (cell.kind === 'f' && depth === 0) return formulaText(cell.value, ref => shownText(ws, ref, depth + 1));
  return null;
}

function rowAt(snapshot: Snapshot, sheet: string, cols: Columns, row: number): ProgressRow | null {
  const raw = snapshot.cell(sheet, row, cols.number!)?.value;
  if (!raw || !/^\d+$/.test(raw)) return null;
  const ws = snapshot.sheet(sheet);
  const text = (col: number | undefined) => (col ? shownText(ws, `${columnLetter(col)}${row}`) ?? '' : '').trim();
  const name = cols.name ? shownText(ws, `${columnLetter(cols.name)}${row}`)?.trim() || null : null;
  return {
    sheet, row, number: Number(raw), name, supplier: text(cols.supplier), reviewer: text(cols.creator), keyword: text(cols.keyword),
    head_reference: text(cols.head_reference), creative_reference: text(cols.creative_reference), primary_tag: text(cols.primary_tag),
    secondary_tag: text(cols.secondary_tag), creative_form: text(cols.creative_form),
  };
}

/** Every row of every usable GOFCN tab that has a material number, in sheet order. */
function* progressRows(snapshot: Snapshot): Generator<ProgressRow> {
  for (const [sheet, cols] of Object.entries(scanSheets(snapshot).tables)) {
    for (let row = 2; row <= snapshot.last[sheet]!; row++) {
      const found = rowAt(snapshot, sheet, cols, row);
      if (found) yield found;
    }
  }
}

/** The progress sheet rows of the wanted material numbers, from every usable GOFCN tab (a number on two rows is two rows). */
export function progressRowsFrom(snapshot: Snapshot, numbers: Iterable<number>): Map<number, ProgressRow[]> {
  const wanted = new Set(numbers);
  const found = new Map<number, ProgressRow[]>();
  if (wanted.size === 0) return found;
  for (const entry of progressRows(snapshot)) {
    if (wanted.has(entry.number)) found.set(entry.number, [...(found.get(entry.number) ?? []), entry]);
  }
  return found;
}

const MAX_LISTED = 40;

/**
 * The rows `gof creative rows` lists, for working out which row a file is: those of the given numbers, and those whose 素材名称 or 提炼词
 * contains one of the texts (newest numbers first, at most 40; `more` says how many were left out).
 */
export function searchProgressRows(snapshot: Snapshot, numbers: number[], texts: string[]): { rows: ProgressRow[]; not_found: number[]; more: number } {
  const wanted = new Set(numbers);
  const needles = texts.map(t => t.toLowerCase());
  const byNumber: ProgressRow[] = [];
  const byText: ProgressRow[] = [];
  for (const entry of progressRows(snapshot)) {
    if (wanted.has(entry.number)) byNumber.push(entry);
    else if (needles.some(t => (entry.name ?? '').toLowerCase().includes(t) || entry.keyword.toLowerCase().includes(t))) byText.push(entry);
  }
  byText.sort((a, b) => b.number - a.number);
  const room = Math.max(0, MAX_LISTED - byNumber.length);
  return {
    rows: [...byNumber.sort((a, b) => a.number - b.number), ...byText.slice(0, room)],
    not_found: numbers.filter(n => !byNumber.some(r => r.number === n)),
    more: Math.max(0, byText.length - room),
  };
}

/** Material numbers as a command line gives them: "67680-67683,67690", "GOFCN67680-GOFCN67683" (a CLS requirement name), "67680 67681". */
export function parseNumbers(text: string): number[] {
  const out: number[] = [];
  for (const part of text.split(/[,，、;；\s]+/).filter(Boolean)) {
    const m = /^(?:GOFCN)?(\d{1,9})(?:[-~～至](?:GOFCN)?(\d{1,9}))?$/i.exec(part);
    need(m, `看不懂的编号：${part}（写成 67680、GOFCN67680 或 67680-67683）`);
    const from = Number(m[1]);
    const to = m[2] === undefined ? from : Number(m[2]);
    need(from > 0 && to >= from && to - from < 500, `编号范围不对：${part}`);
    for (let n = from; n <= to; n++) if (!out.includes(n)) out.push(n);
  }
  need(out.length > 0 && out.length <= 500, '要写 1 到 500 个编号');
  return out;
}

/** Problems grouped by what is wrong, each with the files it concerns ("创意人未定：a.mp4、b.mp4 等 12 个文件"). */
function grouped(problems: { reason: string; file?: string }[]): string {
  const byReason = new Map<string, string[]>();
  for (const p of problems) byReason.set(p.reason, [...(byReason.get(p.reason) ?? []), ...(p.file ? [p.file] : [])]);
  return [...byReason].map(([reason, files]) => files.length === 0 ? reason
    : `${reason}：${files.slice(0, 5).join('、')}${files.length > 5 ? ` 等 ${files.length} 个文件` : ''}`).join('；');
}

/**
 * The progress sheet row a file is: the one the request names for it (`items[].number`, worked out from the requirement), else the one
 * the GOFCN number in its file name points at. Refused, saying what to do, when there is none, more than one, or no 素材名称 on it.
 */
function rowOf(material: Material, item: ItemRequest, rows: Map<number, ProgressRow[]>): { row: ProgressRow & { name: string }; by: 'item' | 'file_name' } {
  const by = item.number !== undefined ? 'item' : 'file_name';
  const number = item.number ?? material.number;
  need(number !== null, '文件名不是进度表里的素材名称，也不带 GOFCN 编号：按需求文档、脚本内容判断它是进度表的哪一行，用 items[].number 写明');
  const found = rows.get(number) ?? [];
  need(found.length > 0, `进度表里没有 GOFCN${number}${by === 'file_name' ? '（编号取自文件名）' : ''}`);
  need(found.length === 1, `进度表里 GOFCN${number} 有 ${found.length} 行（${found.map(r => `${r.sheet} 第 ${r.row} 行`).join('、')}），对不上唯一的素材名称`);
  const row = found[0]!;
  need(row.name, `进度表 GOFCN${number}（${row.sheet} 第 ${row.row} 行）的素材名称为空或算不出来`);
  return { row: row as ProgressRow & { name: string }, by };
}

export function buildUploadPlan(input: PlanInput): Obj {
  const { request, options, materials, existing } = input;
  need(options.can_upload, `CLS 账号“${options.account.name}”在 ${options.game.code} 没有上传创意的权限`);
  const bySheet = request.progress !== false;
  need(!bySheet || input.progress, '没有读取进度表，定不了素材名称');
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
    let bound: ReturnType<typeof rowOf> | undefined;
    try { bound = bySheet ? rowOf(material, item, input.progress!) : undefined; } catch (error) {
      if (!(error instanceof Blocked)) throw error;
      problems.push({ reason: error.message, file: label });
      continue;
    }
    const row = bound?.row;
    // Every name is checked, whatever else is wrong with the file, so that the user hears of all of it at once.
    const name = (row ? row.name : item.name ?? material.name).replace(BIDI, '');
    const renamed = name !== material.name;
    const key = name.toLowerCase();
    if (named.has(key)) {
      problems.push({ reason: row ? `两个文件对应进度表同一行 GOFCN${row.number}（${named.get(key)}、${label}），只能留一个`
        : `两个文件会得到同一个创意名称“${name}”（${named.get(key)}、${label}），请改名或只留一个` });
    } else named.set(key, label);
    if (existing.has(name)) {
      problems.push({ file: renamed ? `${label} → ${name}` : name, reason: !bound ? 'CLS 已有同名创意（CLS 会拒绝整批上传），请改名或不上传'
        : bound.by === 'file_name' ? 'CLS 已有这一行的创意：文件名里的编号可能是参考的初版编号，不是这个文件的；按需求文档判断它是进度表的哪一行，用 items[].number 写明（已经传过的就不再传）'
        : 'CLS 已有这一行的创意（CLS 会拒绝整批上传）：已经传过的就不再传，否则核对 items[].number' });
    }
    try {
      need(!/[\\/]/.test(name), '创意名称不能含 / 或 \\');
      const directory = item.directory ? findDirectory(options.directories, item.directory) : defaultDirectory;
      const type = materialType(options.types, item.type, material.kind);
      // 创意人 / 制作人: the file's own setting, then the request's, then the file's row of the progress sheet.
      const creatorName = item.creator ?? request.creator ?? row?.reviewer;
      const producerNames = item.producers ?? request.producers ?? (row ? splitNames(row.supplier) : undefined);
      need(creatorName && creatorName.trim(), `创意人未定${row ? `（进度表 GOFCN${row.number} 的创意者脚本审核人为空）` : ''}`);
      need(producerNames && producerNames.length > 0, `制作人未定${row ? `（进度表 GOFCN${row.number} 的设计师供应商为空）` : ''}`);
      // The sheet's short names are not always CLS's (廿十一 / 长沙廿拾一文化传媒有限公司): a refusal says where the name came from.
      const sheetSays = (field: 'creator' | 'producers', column: string) =>
        row && (item[field] ?? request[field]) === undefined ? `（这是进度表 GOFCN${row.number} 的${column}；CLS 里叫法不同就用 ${field} 写明 CLS 的名字，gof creative options 列出可选的人）` : '';
      const creator = withHint(() => person(options.creators, creatorName, `创意人“${creatorName}”`), sheetSays('creator', '创意者脚本审核人'));
      const producers = producerNames.map(n => withHint(() => person(options.producers, n, `制作人“${n}”`), sheetSays('producers', '设计师供应商')));
      need(new Set(producers.map(p => p.id)).size === producers.length, '制作人重复');
      const source = {
        name: row ? 'progress' : item.name !== undefined ? 'item' : 'file',
        creator: item.creator !== undefined ? 'item' : request.creator !== undefined ? 'request' : 'progress',
        producers: item.producers !== undefined ? 'item' : request.producers !== undefined ? 'request' : 'progress',
        ...(bound ? { progress_row: { sheet: bound.row.sheet, row: bound.row.row, number: bound.row.number, name: bound.row.name,
          supplier: bound.row.supplier, reviewer: bound.row.reviewer, by: bound.by } } : {}),
      };
      items.push({
        file: material.file, file_name: material.file_name, size: material.size, mtime_ms: material.mtime_ms, sha256: material.sha256, md5: material.md5,
        kind: material.kind, name, number: row?.number ?? material.number,
        // A renamed file goes up under its new name too, as if it had been renamed before the upload; the file on disk stays as it is.
        ...(renamed ? { renamed_from: material.name, upload_name: `${name}${path.extname(material.file_name)}` } : {}),
        type, directory, creator, producers, source,
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

/**
 * What the user is shown before approving: counts by type, creator and producer, the directory, how many files go up under another
 * name, and each file in short (its name in CLS, and the progress sheet row it is: `row_from` request = as the request said, file_name =
 * by the GOFCN number in the file name).
 */
export function uploadPlanSummary(plan: Obj, file: string, limit = 40): Obj {
  const count = (values: string[]) => values.reduce<Record<string, number>>((acc, v) => ({ ...acc, [v]: (acc[v] ?? 0) + 1 }), {});
  const items: Obj[] = plan.items;
  const renamed = items.filter(i => i.renamed_from !== undefined).length;
  return {
    status: 'upload_plan', plan: file, count: items.length,
    directories: count(items.map(i => i.directory.path)),
    types: count(items.map(i => i.type.name)),
    creators: count(items.map(i => i.creator.name)),
    producers: count(items.map(i => i.producers.map((p: Person) => p.name).join('、'))),
    ...(plan.progress_source ? { progress_source: plan.progress_source } : {}),
    ...(renamed ? { renamed } : {}),
    items: items.slice(0, limit).map(i => ({
      file: i.file_name, name: i.name, ...(i.renamed_from !== undefined ? { renamed: true } : {}),
      type: i.type.name, creator: i.creator.name, producers: i.producers.map((p: Person) => p.name),
      ...(i.source.progress_row ? { progress_row: `${i.source.progress_row.sheet} 第 ${i.source.progress_row.row} 行`,
        row_from: i.source.progress_row.by === 'item' ? 'request' : 'file_name' } : {}),
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
