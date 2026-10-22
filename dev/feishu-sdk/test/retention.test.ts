import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from './helpers/tmp.ts';
import { resolveDataPaths } from '../src/paths.ts';
import { pruneExpired, retentionDays } from '../src/retention.ts';

const DAY = 86_400_000;
const write = (file: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'x'); return file; };
/** Files cannot be backdated, so time moves instead: what is 'now' for the sweep is `days` after the files were made. */
const later = (days: number) => Date.now() + days * DAY;

test('the retention period is 7 days unless the environment gives a whole number of days', () => {
  assert.equal(retentionDays({}), 7);
  assert.equal(retentionDays({ REQUIREMENT_AUTO_RETENTION_DAYS: '3' }), 3);
  for (const bad of ['0', '-2', '1.5', 'abc', '']) assert.equal(retentionDays({ REQUIREMENT_AUTO_RETENTION_DAYS: bad }), 7);
});

test('old batches and temporary files go; the logins next to them, and anything still fresh, stay', async () => {
  const paths = resolveDataPaths({ LARK_AGENT_USER_DIR: tempDir('ra-ret-') });
  const batch = write(path.join(paths.batches, 'abc123', 'manifest.json'));
  write(path.join(paths.batches, 'abc123', 'nested', 'evidence.json'));
  const snapshot = write(path.join(paths.tmp, 'snap.xlsx'));
  const auth = write(paths.auth);
  const account = write(path.join(paths.root, 'cls', 'account.json'));
  const profile = write(path.join(paths.root, 'cls', 'browser-profile', 'Default', 'Cookies'));

  assert.equal(await pruneExpired(paths, later(6)), 0, 'inside the period nothing goes');
  assert.ok(fs.existsSync(batch) && fs.existsSync(snapshot));

  assert.equal(await pruneExpired(paths, later(8)), 2, 'the batch folder and the temporary file');
  assert.ok(!fs.existsSync(path.join(paths.batches, 'abc123')) && !fs.existsSync(snapshot));
  assert.ok(fs.existsSync(paths.batches) && fs.existsSync(paths.tmp), 'the folders themselves stay');
  for (const kept of [auth, account, profile]) assert.ok(fs.existsSync(kept), `${kept} is login data and stays`);
});

test('a batch is removed whole or not at all: one recently touched file keeps all of it', async () => {
  const paths = resolveDataPaths({ LARK_AGENT_USER_DIR: tempDir('ra-ret-') });
  const old = write(path.join(paths.batches, 'busy', 'manifest.json'));
  const recent = path.join(paths.batches, 'busy', 'events.jsonl');
  write(recent);
  const now = Date.now() + 8 * DAY;
  // A file written 'now' (8 days on) is the one still in use.
  fs.utimesSync(recent, new Date(now), new Date(now));
  assert.equal(await pruneExpired(paths, now), 0);
  assert.ok(fs.existsSync(old) && fs.existsSync(recent));
});

test('every unpacked zip is judged on its own: one unpacked recently does not keep the older ones', async () => {
  const paths = resolveDataPaths({ LARK_AGENT_USER_DIR: tempDir('ra-ret-') });
  const oldZip = write(path.join(paths.tmp, 'unpacked', 'aaaa-old', 'files', 'big.mp4'));
  write(path.join(paths.tmp, 'unpacked', 'aaaa-old', 'complete.json'));
  const recent = write(path.join(paths.tmp, 'unpacked', 'bbbb-new', 'complete.json'));
  const now = later(8);
  fs.utimesSync(recent, new Date(now), new Date(now));
  assert.equal(await pruneExpired(paths, now), 1);
  assert.ok(!fs.existsSync(path.dirname(path.dirname(oldZip))), 'the old one goes');
  assert.ok(fs.existsSync(recent), 'the recent one stays');
  assert.ok(fs.existsSync(path.join(paths.tmp, 'unpacked')), 'and so does the folder that holds them');
});

test('a missing folder is fine, and a link in place of a folder is not followed', async () => {
  const paths = resolveDataPaths({ LARK_AGENT_USER_DIR: tempDir('ra-ret-') });
  assert.equal(await pruneExpired(paths, later(30)), 0);
  const outside = write(path.join(tempDir('ra-out-'), 'keep.txt'));
  fs.mkdirSync(paths.root, { recursive: true });
  try { fs.symlinkSync(path.dirname(outside), paths.tmp, 'junction'); } catch { return; /* no right to make links here */ }
  assert.equal(await pruneExpired(paths, later(30)), 0);
  assert.ok(fs.existsSync(outside));
});
