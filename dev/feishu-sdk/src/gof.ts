import { main } from './gof/cli.ts';
import { canonical } from './gof/util.ts';

// Entry of server/dist/gof.mjs: the skill's command line (batch, feishu and cls commands).
const { result, code } = await main(process.argv.slice(2));
process.stdout.write(`${canonical(result)}
`);
process.exitCode = code;
