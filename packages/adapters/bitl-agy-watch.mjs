#!/usr/bin/env node
// Antigravity (agy) approval-wait watcher. bitl-hook.mjs spawns it separately on each PreToolUse (agy doesn't wait).
//
//   node bitl-agy-watch.mjs <temp file holding the PreToolUse payload>
//
// agy hooks have no approval-wait event → briefly watch that step's (stepIdx) status in the conversation DB:
//   when it starts waiting for approval, send bitl:PermissionWaiting; when approved/denied/cancelled, bitl:PermissionResolved.
//   If it finishes before that (most tools), send nothing and exit.
// On Node without node:sqlite (< 22.5) or without the DB (IDE etc.), exit quietly. Always exit 0.

import { readFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { sendRecord } from './send.mjs';

const POLL_MS = 400;
const MAX_MS = 10 * 60_000; // stop watching if approval is put off longer than this
const NO_STEP_MS = 15_000; // how long to wait for the step to appear in the DB

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
      // already gone
    }
  }
  const { conversationId, stepIdx } = payload ?? {};
  if (typeof conversationId !== 'string' || !/^[\w-]+$/.test(conversationId) || typeof stepIdx !== 'number') return;

  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch {
    return; // old Node
  }
  const { agyWatchStep } = await import('./dist/core.mjs');
  const dbPath = join(homedir(), '.gemini', 'antigravity-cli', 'conversations', `${conversationId}.db`);

  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return; // no DB (IDE etc.)
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
        // agy is writing (locked) — try again next time
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
