// Bundles the bridge and the skill's command line into the plugin: plugins/requirement-auto/server/dist/{bridge,gof}.mjs (+ one shared chunk).
// The plugin is installed by copying its folder, so everything it needs at run time has to be in these files.
import { build } from 'esbuild';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const outdir = path.resolve(here, '../../plugins/requirement-auto/server/dist');

// The Feishu SDK, axios, ws and protobufjs are CommonJS and expect require, __filename and __dirname.
const shims = [
  "import { createRequire as __createRequire } from 'node:module';",
  "import { fileURLToPath as __fileURLToPath } from 'node:url';",
  "import { dirname as __dirnameOf } from 'node:path';",
  'const require = __createRequire(import.meta.url);',
  'const __filename = __fileURLToPath(import.meta.url);',
  'const __dirname = __dirnameOf(__filename);',
].join('\n');

await rm(outdir, { recursive: true, force: true });
await build({
  entryPoints: { bridge: path.join(here, 'src/cli.ts'), gof: path.join(here, 'src/gof.ts') },
  outdir, outExtension: { '.js': '.mjs' }, entryNames: '[name]', chunkNames: 'shared-[hash]',
  bundle: true, splitting: true, format: 'esm', platform: 'node', target: 'node24',
  legalComments: 'none', sourcemap: false, minify: true, logLevel: 'info',
  banner: { js: shims },
  // Optional native accelerators of `ws`; it falls back to plain JavaScript without them.
  external: ['bufferutil', 'utf-8-validate'],
});
