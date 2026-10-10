#!/usr/bin/env node
// Phase 0: dumps raw agent hook/notify payloads as-is to a JSONL file.
//
// Usage
//   Claude Code / Codex hooks : node dump-hook.mjs --source claude-code   (payload on stdin)
//   Codex notify              : node dump-hook.mjs --source codex-notify  (payload is the last argv)
//
// Location: $BITL_DUMP_DIR or ~/.bitl/dumps/<source>-<YYYY-MM-DD>.jsonl
//
// Principle: never get in the agent's way.
//   - write nothing to stdout (stdout of SessionStart/UserPromptSubmit is injected into the context)
//   - exit 0 on any error

import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const MAX_STRING = 4000; // truncate large strings such as tool_result before saving
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

  // Codex notify passes the JSON as the last argument.
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
    // Antigravity payloads have no event name, so it comes via --event
    event: argValue('--event') ?? payload.hook_event_name ?? payload.type ?? null,
    pid: process.pid,
    ppid: process.ppid,
    payload: truncate(payload),
  };

  const dir = process.env.BITL_DUMP_DIR ?? join(homedir(), '.bitl', 'dumps');
  mkdirSync(dir, { recursive: true });
  const day = new Date().toLocaleDateString('sv-SE'); // local date YYYY-MM-DD
  appendFileSync(join(dir, `${source}-${day}.jsonl`), JSON.stringify(record) + '\n', 'utf8');
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
