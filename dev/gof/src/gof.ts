import { main } from './gof/cli.ts';
import { closeFeishu } from './gof/feishu-plugin.ts';
import { canonical } from './gof/util.ts';
import { resolveDataPaths } from './paths.ts';
import { pruneExpired } from './retention.ts';

// Entry of server/dist/gof.mjs: the skill's command line (batch, feishu and cls commands).
// First, old batches and temporary files of this user go (see retention.ts). Failing to tidy up never stops the command.
try { await pruneExpired(resolveDataPaths()); } catch { /* a bad data directory is reported by the command itself */ }
const { result, code } = await main(process.argv.slice(2));
closeFeishu();
process.stdout.write(`${canonical(result)}
`);
process.exitCode = code;
