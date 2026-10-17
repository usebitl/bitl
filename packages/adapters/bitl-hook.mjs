#!/usr/bin/env node
// Forwards agent hook/notify payloads to bitl-server.
//
//   Claude Code / Codex hooks : node bitl-hook.mjs --source claude-code|codex   (payload on stdin)
//   Codex notify              : node bitl-hook.mjs --source codex-notify        (payload is the last argv)
//   Antigravity hooks         : node bitl-hook.mjs --source antigravity --event PreToolUse   (the payload has no event name)
//
// Server: $BITL_URL (default http://127.0.0.1:$BITL_PORT, 7777)
// If the server is down, records pile up (encrypted) in $BITL_HOME/queue.jsonl (default ~/.bitl) and are processed when the server starts.
//
// Principle: never get in the agent's way — no stdout, always exit 0, short timeouts.
// Parsing (normalization), minimization and encryption happen on this PC (send.mjs → dist/core.mjs). The server can't read the content.
// When the rules change, just rebuild the bundle (pnpm build). The install path stays the same, so no reinstall is needed.

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

/** agy doesn't report approval waits via hooks → spawn a separate process to watch that step (bitl-agy-watch.mjs) */
function watchAgyPermission(payload) {
  try {
    if (typeof payload.stepIdx !== 'number') return;
    const file = join(tmpdir(), `bitl-agy-${process.pid}-${Date.now()}.json`);
    writeFileSync(file, JSON.stringify(payload), 'utf8');
    const script = join(import.meta.dirname, 'bitl-agy-watch.mjs');
    spawn(process.execPath, [script, file], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch {
    // the hook carries on even if the watcher can't start
  }
}

/**
 * Claude Code sends no hook when the user interrupts a turn → on each prompt, spawn a watcher that reads the transcript
 * until the turn ends and reports an interrupt (bitl-cc-watch.mjs). Only ids and the path are passed, never the prompt
 */
function watchClaudeTurn(payload) {
  try {
    const { session_id: sessionId, transcript_path: transcriptPath, cwd } = payload;
    if (typeof sessionId !== 'string' || typeof transcriptPath !== 'string') return;
    const script = join(import.meta.dirname, 'bitl-cc-watch.mjs');
    const args = [script, sessionId, transcriptPath, typeof cwd === 'string' ? cwd : ''];
    spawn(process.execPath, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch {
    // the hook carries on even if the watcher can't start
  }
}

/**
 * Claude Code agent view (`claude agents`): the daemon keeps pre-warmed sessions parked as spares (CLAUDE_BG_SOURCE=spare).
 * A parked spare fires SessionStart but gets no prompt until a task is dispatched to it, and is retired after an hour idle
 * without a SessionEnd reaching us — so its start would sit on the board as an empty card. Drop only the start: if a task
 * is dispatched later, its first prompt creates the card.
 */
const isParkedSpareStart = (source, payload) =>
  source === 'claude-code' &&
  payload?.hook_event_name === 'SessionStart' &&
  process.env.CLAUDE_CODE_SESSION_KIND === 'bg' &&
  process.env.CLAUDE_BG_SOURCE === 'spare';

async function main() {
  const receivedAt = new Date().toISOString(); // when the hook ran (not when it reached the server)
  const source = argValue('--source') ?? 'claude-code';

  const lastArg = process.argv[process.argv.length - 1];
  const raw = lastArg?.trimStart().startsWith('{') ? lastArg : await readStdin();
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return; // drop input we can't parse
  }
  // Antigravity payloads have no event name, so it comes via --event
  const event = argValue('--event');
  if (event && payload && typeof payload === 'object' && payload.hook_event_name === undefined) payload.hook_event_name = event;
  if (source === 'antigravity' && event === 'PreToolUse') watchAgyPermission(payload);
  if (source === 'claude-code' && payload?.hook_event_name === 'UserPromptSubmit') watchClaudeTurn(payload);
  if (isParkedSpareStart(source, payload)) return;
  await sendRecord({ source, receivedAt, payload });
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
