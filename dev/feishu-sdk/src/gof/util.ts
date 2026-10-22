import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** A refusal with a message for the user. The CLI prints it as {"status":"blocked","reason":…} and exits 2. */
export class Blocked extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Blocked';
  }
}

/** A refusal after a write went out: what happened has to be read back (reconcile); planning and sending again could append the rows twice. */
export class WriteSent extends Blocked {
  readonly batch: string;
  constructor(message: string, batch: string) {
    super(message);
    this.name = 'WriteSent';
    this.batch = batch;
  }
}

export function need(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Blocked(message);
}

export const NODE = 'YFyywzwLsiT07EkpBaecr8nIncn';
export const TARGET = `https://centurygames.feishu.cn/wiki/${NODE}`;
export const FIXED_TAG = '玩法卖点（单选，必选）/展示向/展示向';
export const CSV_HEADERS = ['脚本名称', '脚本内容', '创意标签'];

/** Unicode code point order, which is the order the original scripts sorted keys in, and so what existing digests were computed over. */
export function compareCodePoints(a: string, b: string): number {
  const x = Array.from(a, ch => ch.codePointAt(0)!);
  const y = Array.from(b, ch => ch.codePointAt(0)!);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return x.length - y.length;
}

/** Sorted-key compact JSON, the form every digest and seal in a batch is computed over. */
export function canonical(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
    entries.sort(([a], [b]) => compareCodePoints(a, b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export function digest(value: unknown): string {
  return sha256(canonical(value));
}

export function readJson<T = any>(file: string): T {
  const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  return JSON.parse(text) as T;
}

/**
 * Exclusive create: an existing file is an error, never overwritten. The content is written to a side file first and linked into
 * place, so a process that dies half-way leaves no truncated file under the real name (an event log with one cannot be read at all).
 */
export function writeJsonNew(file: string, data: unknown): void {
  const side = `${file}.${process.pid}.${createHash('sha256').update(String(Math.random())).digest('hex').slice(0, 8)}.tmp`;
  fs.writeFileSync(side, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  try { fs.linkSync(side, file); } finally { fs.rmSync(side, { force: true }); }
}

/** Is `file` somewhere below `dir`? */
export function isInside(dir: string, file: string): boolean {
  const relative = path.relative(path.resolve(dir), path.resolve(file));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

export function isObject(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseUrl(url: string): URL | undefined {
  try { return new URL(url); } catch { return undefined; }
}

export function checkTarget(url: string): void {
  const p = parseUrl(url);
  need(p && p.protocol === 'https:' && p.hostname === 'centurygames.feishu.cn' && (p.port === '' || p.port === '443')
    && !p.username && !p.password && p.pathname.replace(/\/+$/, '') === `/wiki/${NODE}`, '实际页面不是获准的测试进度表节点');
}

export function checkClsUrl(url: string): void {
  const p = parseUrl(url);
  need(p && p.protocol === 'https:' && p.hostname === 'creative.centurygames.cn' && (p.port === '' || p.port === '443')
    && !p.username && !p.password, '草稿 URL 必须是实际 CLS 页面');
}

/** A Feishu document link: https, the company host, no credentials, /wiki/<token> or /docx/<token>. Returns the path. */
export function feishuDocPath(url: string, kinds: string, trailingSlash = false): string | undefined {
  const p = parseUrl(url);
  if (!p || p.protocol !== 'https:' || p.hostname !== 'centurygames.feishu.cn' || p.username || p.password
    || !(p.port === '' || p.port === '443')) return undefined;
  return new RegExp(`^/(${kinds})/[A-Za-z0-9]+${trailingSlash ? '/?' : ''}$`).test(p.pathname) ? p.pathname : undefined;
}

export function cellText(value: unknown, label: string): string {
  need(typeof value === 'string', `${label} 必须是文本`);
  need(!/[\t\r\n\0]/.test(value), `${label} 不能包含表格分隔符或换行`);
  need(!value.trimStart().startsWith('='), `${label} 不能作为公式粘贴`);
  return value;
}

export function safeFilename(value: string): string {
  return Array.from(value.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/^[ .]+|[ .]+$/g, '')).slice(0, 80).join('');
}
