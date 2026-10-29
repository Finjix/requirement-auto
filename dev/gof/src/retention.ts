import fs from 'node:fs/promises';
import path from 'node:path';
import type { DataPaths } from './paths.ts';

export const RETENTION_DAYS_ENV = 'REQUIREMENT_AUTO_RETENTION_DAYS';
/** The folder of tmp that holds one folder per unpacked zip. */
export const UNPACKED = 'unpacked';
const DAY = 86_400_000;

/** Days to keep untouched batches and temporary files: 7 like lark-agent's workspace, a whole number of at least 1 from the environment. */
export function retentionDays(env: NodeJS.ProcessEnv = process.env): number {
  const given = Number(env[RETENTION_DAYS_ENV]);
  return Number.isInteger(given) && given >= 1 ? given : 7;
}

/** The most recent creation, change or move of a file; a link is looked at as a link, never followed. */
async function touched(target: string): Promise<{ at: number; directory: boolean } | undefined> {
  const stat = await fs.lstat(target).catch(() => undefined);
  if (!stat) return undefined;
  return { at: Math.max(stat.birthtimeMs, stat.mtimeMs, stat.ctimeMs), directory: stat.isDirectory() };
}

/** The newest `touched` of a file or of anything below a directory. A directory that cannot be read counts as new: nothing is removed on a guess. */
async function newest(target: string): Promise<number> {
  const info = await touched(target);
  if (!info) return 0;
  if (!info.directory) return info.at;
  let latest = info.at;
  try {
    for (const entry of await fs.readdir(target)) latest = Math.max(latest, await newest(path.join(target, entry)));
  } catch { return Infinity; }
  return latest;
}

/**
 * Deletes what nobody has touched for `days` from this user's batches and temporary files, and nothing else: the Feishu login, the CLS login
 * and its account record live next to them and stay. A batch goes whole, and only when nothing in it is newer than the cutoff, so a batch
 * that is still being worked on is never cut in half. What cannot be deleted now is left for the next run. Returns how many entries went.
 */
export async function pruneExpired(paths: Pick<DataPaths, 'batches' | 'tmp'>, now: number = Date.now(), days: number = retentionDays()): Promise<number> {
  const cutoff = now - days * DAY;
  let removed = 0;
  /** Each entry of a real folder (a link in its place would lead the sweep out of the user's directory) goes whole once nothing in it is recent. */
  const sweep = async (root: string, keepEntry: (name: string) => Promise<boolean> = async () => false) => {
    if (!(await fs.lstat(root).catch(() => undefined))?.isDirectory()) return;
    for (const name of await fs.readdir(root).catch(() => [] as string[])) {
      const target = path.join(root, name);
      try {
        if (await keepEntry(name) || await newest(target) >= cutoff) continue;
        await fs.rm(target, { recursive: true, force: true });
        removed++;
      } catch { /* open in a program or no permission: next time */ }
    }
  };
  await sweep(paths.batches);
  // Every zip unpacked for an upload is a folder of its own under tmp/unpacked, and is judged on its own: one unpacked last week must not
  // keep every older one (each up to 20 GB) for as long as the user goes on uploading.
  await sweep(paths.tmp, async name => {
    if (name !== UNPACKED) return false;
    await sweep(path.join(paths.tmp, UNPACKED));
    return true;
  });
  return removed;
}
