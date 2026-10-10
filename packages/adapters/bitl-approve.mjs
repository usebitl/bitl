#!/usr/bin/env node
// Remote approval hook (Claude Code PermissionRequest, synchronous). bitl install installs it alongside bitl-hook.mjs.
//
//   node bitl-approve.mjs [--source claude-code]   (payload on stdin)
//
// Only when remote approval is on (the board's "remote approval" switch or bitl remote on) does it wait for allow/deny from the phone (default 10 min, $BITL_APPROVAL_WAIT_SEC).
// Otherwise it prints nothing and exits right away → Claude Code shows its approval prompt in the terminal as usual.
// The phone's decision is followed only after verifying the account key signature (the server can't forge an approval). Every failure falls back to "approve in the terminal".
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
  .catch((err) => log(`remote approval:${err?.stack ?? err}`))
  .finally(() => process.exit(0));
