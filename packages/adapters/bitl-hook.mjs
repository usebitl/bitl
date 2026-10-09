#!/usr/bin/env node
// 에이전트 hook/notify 페이로드를 bitl-server 로 전달한다.
//
//   Claude Code / Codex hooks : node bitl-hook.mjs --source claude-code|codex   (페이로드는 stdin)
//   Codex notify              : node bitl-hook.mjs --source codex-notify        (페이로드는 마지막 argv)
//   Antigravity hooks         : node bitl-hook.mjs --source antigravity --event PreToolUse   (이벤트 이름이 페이로드에 없다)
//
// 서버: $BITL_URL (기본 http://127.0.0.1:$BITL_PORT, 7777)
// 서버가 꺼져 있으면 $BITL_HOME/queue.jsonl (기본 ~/.bitl) 에 (암호화한 채로) 쌓아두고, 서버가 시작할 때 처리한다.
//
// 원칙: 에이전트를 절대 방해하지 않는다 — stdout 무출력, 항상 exit 0, 짧은 타임아웃.
// 해석(정규화)·최소화·암호화는 이 PC 에서 한다 (send.mjs → dist/core.mjs). 서버는 내용을 읽지 못한다.
// 규칙이 바뀌면 번들만 다시 빌드하면 된다 (pnpm build). 설치 경로가 그대로라 재설치는 필요 없다.

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sendRecord } from './send.mjs';

const STDIN_TIMEOUT_MS = 2000;

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let data = '';
    const timer = setTimeout(() => resolve(data), STDIN_TIMEOUT_MS);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => {
      clearTimeout(timer);
      resolve(data);
    });
    process.stdin.on('error', () => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

/** agy 는 승인 대기를 hook 으로 알리지 않는다 → 그 단계를 지켜볼 프로세스를 따로 띄운다 (bitl-agy-watch.mjs) */
function watchAgyPermission(payload) {
  try {
    if (typeof payload.stepIdx !== 'number') return;
    const file = join(tmpdir(), `bitl-agy-${process.pid}-${Date.now()}.json`);
    writeFileSync(file, JSON.stringify(payload), 'utf8');
    const script = join(import.meta.dirname, 'bitl-agy-watch.mjs');
    spawn(process.execPath, [script, file], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch {
    // 감시를 못 띄워도 hook 은 계속
  }
}

async function main() {
  const receivedAt = new Date().toISOString(); // hook 이 실행된 시각 (서버 도착 시각이 아님)
  const source = argValue('--source') ?? 'claude-code';

  const lastArg = process.argv[process.argv.length - 1];
  const raw = lastArg?.trimStart().startsWith('{') ? lastArg : await readStdin();
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return; // 해석할 수 없는 입력은 버린다
  }
  // Antigravity 는 페이로드에 이벤트 이름이 없어 --event 로 받는다
  const event = argValue('--event');
  if (event && payload && typeof payload === 'object' && payload.hook_event_name === undefined) payload.hook_event_name = event;
  if (source === 'antigravity' && event === 'PreToolUse') watchAgyPermission(payload);
  await sendRecord({ source, receivedAt, payload });
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
