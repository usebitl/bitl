#!/usr/bin/env node
// Antigravity(agy) 승인 대기 감시. bitl-hook.mjs 가 PreToolUse 마다 따로 띄운다 (agy 는 기다리지 않는다).
//
//   node bitl-agy-watch.mjs <PreToolUse 페이로드를 담은 임시 파일>
//
// agy hook 에는 승인 대기 이벤트가 없다 → 대화 DB 의 그 단계(stepIdx) 상태를 잠깐 지켜본다:
//   승인 대기가 되면 bitl:PermissionWaiting, 승인·거부·취소되면 bitl:PermissionResolved 를 보낸다.
//   그 전에 끝나면(대부분의 도구) 아무것도 보내지 않고 끝난다.
// node:sqlite 가 없는 Node(22.5 미만)·DB 가 없는 환경(IDE 등)에서는 조용히 끝난다. 항상 exit 0.

import { readFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { sendRecord } from './send.mjs';

const POLL_MS = 400;
const MAX_MS = 10 * 60_000; // 승인을 이보다 오래 미루면 더 지켜보지 않는다
const NO_STEP_MS = 15_000; // 단계가 DB 에 나타나기를 기다리는 시간

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const file = process.argv[2];
  if (!file) return;
  let payload;
  try {
    payload = JSON.parse(readFileSync(file, 'utf8'));
  } finally {
    try {
      unlinkSync(file);
    } catch {
      // 이미 없음
    }
  }
  const { conversationId, stepIdx } = payload ?? {};
  if (typeof conversationId !== 'string' || !/^[\w-]+$/.test(conversationId) || typeof stepIdx !== 'number') return;

  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch {
    return; // 오래된 Node
  }
  const { agyWatchStep } = await import('./dist/core.mjs');
  const dbPath = join(homedir(), '.gemini', 'antigravity-cli', 'conversations', `${conversationId}.db`);

  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return; // DB 없음 (IDE 등)
  }
  const query = db.prepare('SELECT status FROM steps WHERE idx = ?');
  const send = (event) => sendRecord({ source: 'antigravity', payload: { ...payload, hook_event_name: event } });

  const started = Date.now();
  let waited = false;
  try {
    while (Date.now() - started < MAX_MS) {
      let status;
      try {
        status = query.get(stepIdx)?.status;
      } catch {
        // agy 가 쓰는 중 (잠김) — 다음에 다시
      }
      if (status === undefined && !waited && Date.now() - started > NO_STEP_MS) return;
      const action = agyWatchStep(status, waited);
      if (action === 'waiting') {
        waited = true;
        await send('bitl:PermissionWaiting');
      } else if (action === 'resolved') {
        await send('bitl:PermissionResolved');
        return;
      } else if (action === 'stop') {
        return;
      }
      await sleep(POLL_MS);
    }
  } finally {
    db.close();
  }
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
