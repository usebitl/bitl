#!/usr/bin/env node
// 원격 승인 hook (Claude Code PermissionRequest, 동기). bitl install 이 bitl-hook.mjs 와 함께 설치한다.
//
//   node bitl-approve.mjs [--source claude-code]   (페이로드는 stdin)
//
// 원격 승인이 켜졌을 때만 (보드의 "원격 승인" 스위치 또는 bitl remote on) 폰의 허용·거부를 기다린다 (기본 10분, $BITL_APPROVAL_WAIT_SEC).
// 그 밖에는 아무것도 출력하지 않고 바로 끝나 → Claude Code 가 평소처럼 터미널에 승인 창을 띄운다.
// 폰의 결정은 계정 키 서명을 확인한 뒤에만 따른다 (서버가 승인을 만들어 낼 수 없다). 실패는 모두 "터미널에서 승인"으로.
import { appendFileSync, mkdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOME = process.env.BITL_HOME?.trim() || join(homedir(), '.bitl');

function log(msg) {
  try {
    const file = join(HOME, 'adapter-error.log');
    try {
      if (statSync(file).size > 1024 * 1024) return;
    } catch {}
    mkdirSync(HOME, { recursive: true });
    appendFileSync(file, `${new Date().toISOString()} ${msg}\n`, 'utf8');
  } catch {}
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    const timer = setTimeout(() => resolve(data), 2000);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => (clearTimeout(timer), resolve(data)));
    process.stdin.on('error', () => (clearTimeout(timer), resolve(data)));
  });
}

const stop = new AbortController();
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => stop.abort());

async function main() {
  const i = process.argv.indexOf('--source');
  const source = i >= 0 ? process.argv[i + 1] : 'claude-code';
  let payload;
  try {
    payload = JSON.parse(await readStdin());
  } catch {
    return;
  }
  if (payload?.hook_event_name !== 'PermissionRequest') return;
  const { requestRemoteApproval } = await import('./dist/core.mjs');
  const waitSec = Number(process.env.BITL_APPROVAL_WAIT_SEC);
  const decision = await requestRemoteApproval(
    { ...payload, source },
    { home: HOME, waitMs: waitSec > 0 ? waitSec * 1000 : undefined, signal: stop.signal, log },
  );
  if (decision) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } }));
}

main()
  .catch((err) => log(`원격 승인: ${err?.stack ?? err}`))
  .finally(() => process.exit(0));
