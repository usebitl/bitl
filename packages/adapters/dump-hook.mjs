#!/usr/bin/env node
// Phase 0: 에이전트 hook/notify 페이로드를 원본 그대로 JSONL 파일에 덤프한다.
//
// 사용법
//   Claude Code / Codex hooks : node dump-hook.mjs --source claude-code   (페이로드는 stdin)
//   Codex notify              : node dump-hook.mjs --source codex-notify  (페이로드는 마지막 argv)
//
// 저장 위치: $BITL_DUMP_DIR 또는 ~/.bitl/dumps/<source>-<YYYY-MM-DD>.jsonl
//
// 원칙: 에이전트를 절대 방해하지 않는다.
//   - stdout 에 아무것도 쓰지 않는다 (SessionStart/UserPromptSubmit 의 stdout 은 컨텍스트로 주입됨)
//   - 어떤 오류가 나도 exit 0

import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const MAX_STRING = 4000; // tool_result 등 큰 문자열은 잘라서 저장
const STDIN_TIMEOUT_MS = 2000;

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function truncate(value) {
  if (typeof value === 'string') {
    return value.length > MAX_STRING
      ? `${value.slice(0, MAX_STRING)}…[truncated ${value.length - MAX_STRING} chars]`
      : value;
  }
  if (Array.isArray(value)) return value.map(truncate);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, truncate(v)]));
  }
  return value;
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

async function main() {
  const source = argValue('--source') ?? 'unknown';

  // Codex notify 는 JSON 을 마지막 인자로 넘긴다.
  const lastArg = process.argv[process.argv.length - 1];
  const raw = lastArg?.trimStart().startsWith('{') ? lastArg : await readStdin();

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    payload = { _unparsed: raw };
  }

  const record = {
    receivedAt: new Date().toISOString(),
    source,
    // Antigravity 는 페이로드에 이벤트 이름이 없어 --event 로 받는다
    event: argValue('--event') ?? payload.hook_event_name ?? payload.type ?? null,
    pid: process.pid,
    ppid: process.ppid,
    payload: truncate(payload),
  };

  const dir = process.env.BITL_DUMP_DIR ?? join(homedir(), '.bitl', 'dumps');
  mkdirSync(dir, { recursive: true });
  const day = new Date().toLocaleDateString('sv-SE'); // 로컬 날짜 YYYY-MM-DD
  appendFileSync(join(dir, `${source}-${day}.jsonl`), JSON.stringify(record) + '\n', 'utf8');
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
