// Builds the npm package (@usebitl/cli, command bitl). Runs before `npm pack`/`npm publish` (prepack).
//   dist/cli.mjs   — packages/cli/src/index.ts bundled into one file, including the local server (bitl start)
//   web/           — the local board UI that bitl start serves
//   adapters/      — files the hooks run (bitl-hook, send, bitl-approve, bitl-agy-watch, bitl-cc-watch + dist/core.mjs)
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
// esbuild is already used by the adapters package
const { build } = createRequire(here('../../adapters/package.json'))('esbuild');

const DEFAULT_URL = 'https://api.usebitl.com';
// bitl version the work PC reports to the server (for update notices on the web devices page)
const VERSION = JSON.parse(readFileSync(here('package.json'), 'utf8')).version;

rmSync(here('dist'), { recursive: true, force: true });
rmSync(here('adapters'), { recursive: true, force: true });
rmSync(here('web'), { recursive: true, force: true });

await build({
  entryPoints: { cli: here('../src/index.ts') },
  outdir: here('dist'),
  outExtension: { '.js': '.mjs' },
  // The local server (bitl start) is bundled too, but in its own chunk loaded only by bitl start:
  // it imports node:sqlite (Node 22.5+), and every other command must keep working on Node 20
  splitting: true,
  chunkNames: 'chunks/[name]-[hash]',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  // Its web UI is built into web/ below
  define: {
    'process.env.BITL_NPM_BUILD': '"1"',
    'process.env.BITL_DEFAULT_URL': JSON.stringify(DEFAULT_URL),
    'process.env.BITL_CLIENT_VERSION': JSON.stringify(VERSION),
  },
  // so bundled CommonJS dependencies can use require
  banner: { js: "import { createRequire as __bitlRequire } from 'node:module'; const require = __bitlRequire(import.meta.url);" },
  logLevel: 'warning',
});

await build({
  entryPoints: [here('../../adapters/src/core.ts')],
  outfile: here('adapters/dist/core.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  define: { 'process.env.BITL_CLIENT_VERSION': JSON.stringify(VERSION) },
  logLevel: 'warning',
});

// Web UI for bitl start: the local board (src/main.tsx), not the cloud site that packages/web/index.html points to
const webRoot = here('../../web');
const { build: viteBuild } = await import(pathToFileURL(createRequire(join(webRoot, 'package.json')).resolve('vite')).href);
const localEntry = {
  name: 'bitl-local-entry',
  transformIndexHtml: {
    order: 'pre',
    // In the public repo index.html already points to src/main.tsx
    handler: (html) => html.replace('/src/cloud/main.tsx', '/src/main.tsx'),
  },
};
await viteBuild({ root: webRoot, logLevel: 'warn', plugins: [localEntry], build: { outDir: here('web'), emptyOutDir: true } });
await viteBuild({ root: webRoot, configFile: join(webRoot, 'vite.sw.config.ts'), logLevel: 'warn', build: { outDir: here('web') } });

// License text (AGPL-3.0): repo root in the public repo, the export overlay in the private one. npm always packs LICENSE
copyFileSync(existsSync(here('../../../LICENSE')) ? here('../../../LICENSE') : here('../../../scripts/oss/overlay/LICENSE'), here('LICENSE'));

mkdirSync(here('adapters'), { recursive: true });
for (const f of ['bitl-hook.mjs', 'send.mjs', 'bitl-approve.mjs', 'bitl-agy-watch.mjs', 'bitl-cc-watch.mjs']) {
  copyFileSync(here(`../../adapters/${f}`), here(`adapters/${f}`));
}
// Use LF line endings: publishing a Windows checkout (CRLF) as is makes #!/usr/bin/env node\r fail on macOS/Linux
const files = (dir) =>
  readdirSync(here(dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(`${dir}/${e.name}`) : [`${dir}/${e.name}`]));
for (const f of [...files('dist'), ...files('adapters'), ...files('bin'), 'package.json', 'README.md', 'LICENSE']) {
  const text = readFileSync(here(f), 'utf8');
  if (text.includes('\r\n')) writeFileSync(here(f), text.replace(/\r\n/g, '\n'));
}
console.log('bitl npm package built: dist/cli.mjs, adapters/');
