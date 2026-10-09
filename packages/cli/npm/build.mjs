// npm 패키지(@usebitl/cli, 명령 bitl) 빌드: CLI 를 한 파일로 묶고, hook 어댑터를 복사한다. `npm pack`·`npm publish` 전에 자동 실행 (prepack).
//   dist/cli.mjs   — packages/cli/src/index.ts 를 묶은 것 (클라우드 전용: 로컬 서버·로컬 MCP 제외)
//   adapters/      — hook 이 실행하는 파일 (bitl-hook·send·bitl-approve·bitl-agy-watch + dist/core.mjs)
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
// esbuild 는 어댑터 패키지가 이미 쓰고 있다
const { build } = createRequire(here('../../adapters/package.json'))('esbuild');

const DEFAULT_URL = 'https://api.usebitl.com';
// 작업 PC 가 서버에 알리는 bitl 버전 (웹의 기기 화면에서 업데이트 안내)
const VERSION = JSON.parse(readFileSync(here('package.json'), 'utf8')).version;

rmSync(here('dist'), { recursive: true, force: true });
rmSync(here('adapters'), { recursive: true, force: true });

await build({
  entryPoints: [here('../src/index.ts')],
  outfile: here('dist/cli.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  // 로컬 서버는 넣지 않는다 (bitl start 는 CLOUD_ONLY 에서 실행 전에 막힌다)
  external: ['@bitl/server'],
  define: {
    'process.env.BITL_CLOUD_ONLY': '"1"',
    'process.env.BITL_DEFAULT_URL': JSON.stringify(DEFAULT_URL),
    'process.env.BITL_CLIENT_VERSION': JSON.stringify(VERSION),
  },
  // 묶인 CommonJS 의존성이 require 를 쓸 수 있게
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

mkdirSync(here('adapters'), { recursive: true });
for (const f of ['bitl-hook.mjs', 'send.mjs', 'bitl-approve.mjs', 'bitl-agy-watch.mjs']) {
  copyFileSync(here(`../../adapters/${f}`), here(`adapters/${f}`));
}
// 줄바꿈은 LF 로: Windows 체크아웃(CRLF) 그대로 게시하면 macOS·Linux 에서 #!/usr/bin/env node\r 가 실행되지 않는다
const files = (dir) =>
  readdirSync(here(dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(`${dir}/${e.name}`) : [`${dir}/${e.name}`]));
for (const f of [...files('dist'), ...files('adapters'), ...files('bin'), 'package.json', 'README.md']) {
  const text = readFileSync(here(f), 'utf8');
  if (text.includes('\r\n')) writeFileSync(here(f), text.replace(/\r\n/g, '\n'));
}
console.log('bitl npm 패키지 빌드 완료: dist/cli.mjs, adapters/');
