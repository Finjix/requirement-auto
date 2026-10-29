import zlib from 'node:zlib';
import { Blocked, need } from './util.ts';

const MAX_ENTRY = 512 * 1024 * 1024;
const MAX_TOTAL = 1024 * 1024 * 1024;

/** A read-only view of a zip file: just enough of the format for an .xlsx (stored or deflated entries, no encryption, no zip64). */
export class ZipReader {
  private readonly entries = new Map<string, { method: number; csize: number; usize: number; offset: number }>();
  private inflated = 0;
  private readonly data: Buffer;

  constructor(data: Buffer) {
    this.data = data;
    const tail = Math.max(0, data.length - 65557);
    let eocd = -1;
    for (let i = data.length - 22; i >= tail; i--) {
      if (data.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    need(eocd >= 0, '不是有效的 XLSX（zip）文件');
    const count = data.readUInt16LE(eocd + 10);
    const size = data.readUInt32LE(eocd + 12);
    const start = data.readUInt32LE(eocd + 16);
    need(count !== 0xffff && size !== 0xffffffff && start !== 0xffffffff, '不支持 zip64 压缩包');
    need(start + size <= data.length, 'XLSX（zip）目录已损坏');
    let pos = start;
    for (let n = 0; n < count; n++) {
      need(pos + 46 <= data.length && data.readUInt32LE(pos) === 0x02014b50, 'XLSX（zip）目录已损坏');
      const flags = data.readUInt16LE(pos + 8);
      need((flags & 1) === 0, '不支持加密的压缩包');
      const method = data.readUInt16LE(pos + 10);
      const csize = data.readUInt32LE(pos + 20);
      const usize = data.readUInt32LE(pos + 24);
      const nameLength = data.readUInt16LE(pos + 28);
      const extraLength = data.readUInt16LE(pos + 30);
      const commentLength = data.readUInt16LE(pos + 32);
      const offset = data.readUInt32LE(pos + 42);
      const name = data.toString('utf8', pos + 46, pos + 46 + nameLength);
      need(!this.entries.has(name), `XLSX 含重复条目：${name}`);
      this.entries.set(name, { method, csize, usize, offset });
      pos += 46 + nameLength + extraLength + commentLength;
    }
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  names(): string[] {
    return [...this.entries.keys()];
  }

  read(name: string): Buffer {
    const entry = this.entries.get(name);
    need(entry, `XLSX 缺少条目：${name}`);
    need(entry.usize <= MAX_ENTRY, `XLSX 条目过大：${name}`);
    const { data } = this;
    need(entry.offset + 30 <= data.length && data.readUInt32LE(entry.offset) === 0x04034b50, 'XLSX（zip）条目已损坏');
    const begin = entry.offset + 30 + data.readUInt16LE(entry.offset + 26) + data.readUInt16LE(entry.offset + 28);
    need(begin + entry.csize <= data.length, 'XLSX（zip）条目已损坏');
    const raw = data.subarray(begin, begin + entry.csize);
    let out: Buffer;
    if (entry.method === 0) out = Buffer.from(raw);
    else if (entry.method === 8) {
      try { out = zlib.inflateRawSync(raw, { maxOutputLength: MAX_ENTRY }); } catch { throw new Blocked(`XLSX 条目无法解压：${name}`); }
    } else throw new Blocked(`不支持的压缩方式：${name}`);
    need(out.length === entry.usize, `XLSX 条目大小不符：${name}`);
    this.inflated += out.length;
    need(this.inflated <= MAX_TOTAL, 'XLSX 解压后过大');
    return out;
  }

  text(name: string): string {
    return this.read(name).toString('utf8').replace(/^﻿/, '');
  }
}
