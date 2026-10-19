// Entry of bridge.mjs: `node bridge.mjs <command>`, JSON arguments on stdin, one JSON line on stdout, exit code 0 or 2.
import { INPUT_COMMANDS, runBridge, type BridgeReply } from './bridge.ts';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

const command = process.argv[2] ?? '';
let reply: BridgeReply;
try {
  // Only the commands that take arguments read stdin; the others must not wait for a pipe somebody forgot to close.
  const text = INPUT_COMMANDS.has(command) ? (await readStdin()).trim() : '';
  reply = await runBridge(command, text ? JSON.parse(text) : undefined);
} catch {
  reply = { ok: false, error: { kind: 'invalid_request', message: '标准输入不是有效的 JSON' } };
}
process.stdout.write(`${JSON.stringify(reply)}\n`);
process.exitCode = reply.ok ? 0 : 2;
