#!/usr/bin/env node
// bitl 명령 (npm 패키지 @usebitl/cli) 진입점.
// hook 이 실행할 어댑터를 ~/.bitl/adapters 에 복사해 두고(버전이 바뀌었을 때만) 그 경로로 CLI 를 실행한다.
// npm 전역 폴더는 Node 버전(nvm 등)에 따라 바뀌어서, hook 이 그 경로를 직접 가리키면 조용히 끊길 수 있다.
//   node bin/bitl.mjs __sync  — 복사만 (npm postinstall). 실패해도 설치는 막지 않는다
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const syncOnly = process.argv[2] === '__sync';
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const home = process.env.BITL_HOME?.trim() || join(homedir(), '.bitl');
const dir = join(home, 'adapters');
const stamp = join(dir, '.version');

try {
  if (!existsSync(stamp) || readFileSync(stamp, 'utf8').trim() !== version) {
    mkdirSync(dir, { recursive: true });
    cpSync(new URL('../adapters/', import.meta.url), dir, { recursive: true, force: true });
    writeFileSync(stamp, version);
  }
} catch (err) {
  if (syncOnly) process.exit(0);
  console.error(`bitl: ${dir} 에 어댑터를 복사하지 못했습니다 — ${err?.message ?? err}`);
  process.exit(1);
}
if (syncOnly) process.exit(0);

process.env.BITL_ADAPTER_DIR = dir;
await import('../dist/cli.mjs');
