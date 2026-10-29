// Bundles the skills' command line into the plugin: plugins/requirement-auto/server/dist/gof.mjs.
// The plugin is installed by copying its folder, so everything it needs at run time has to be in this file. Feishu is the feishu
// plugin's (see src/gof/feishu-plugin.ts), so no Feishu SDK is bundled here.
import { build } from 'esbuild';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const outdir = path.resolve(here, '../../plugins/requirement-auto/server/dist');

await rm(outdir, { recursive: true, force: true });
await build({
  entryPoints: { gof: path.join(here, 'src/gof.ts') },
  outdir, outExtension: { '.js': '.mjs' }, entryNames: '[name]',
  bundle: true, format: 'esm', platform: 'node', target: 'node24',
  legalComments: 'none', sourcemap: false, minify: true, logLevel: 'info',
});
