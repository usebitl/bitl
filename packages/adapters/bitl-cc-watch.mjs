#!/usr/bin/env node
// Claude Code interrupt watcher. bitl-hook.mjs spawns it separately on each UserPromptSubmit (Claude Code doesn't wait).
//
//   node bitl-cc-watch.mjs <session id> <transcript path> <cwd>
//
// Claude Code sends no hook when the user interrupts a turn, so the card would stay "running". Follow the transcript
// until the turn ends; if it was interrupted, send bitl:Interrupted (ends the turn on the board). Only the event goes
// out — no transcript content. Exits quietly on a normal end, after 2 hours, or on any error. Always exit 0.

import { sendRecord } from './send.mjs';

async function main() {
  const [sessionId, transcriptPath, cwd] = process.argv.slice(2);
  if (!sessionId || !transcriptPath) return;
  const { watchClaudeTurn } = await import('./dist/core.mjs');
  const mark = await watchClaudeTurn(transcriptPath);
  if (mark?.mark !== 'interrupted') return;
  await sendRecord({
    source: 'claude-code',
    receivedAt: mark.at ?? new Date().toISOString(),
    payload: { hook_event_name: 'bitl:Interrupted', session_id: sessionId, transcript_path: transcriptPath, ...(cwd ? { cwd } : {}) },
  });
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
