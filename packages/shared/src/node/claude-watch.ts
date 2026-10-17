import { open, stat } from 'node:fs/promises';

/**
 * Claude Code sends no hook when the user interrupts a turn (Esc while it answers — checked on 2.1.302): no Stop,
 * no idle reminder, so the card would stay "running" until it goes stale. The transcript does record it, as a user
 * line "[Request interrupted by user]" ("… for tool use" when a tool was running). bitl-hook.mjs starts a watcher on
 * each prompt that reads only what gets appended to the transcript, and reports the interrupt.
 * The transcript format is not a public spec: if the wording changes, interrupts go unnoticed again (nothing breaks).
 */

export type ClaudeTurnMark = { mark: 'interrupted' | 'ended'; at?: string };

const INTERRUPTED = '[Request interrupted by user';

/** What one transcript line says about the main turn: interrupted, ended normally, or nothing */
export function claudeTurnMark(line: string): ClaudeTurnMark | null {
  // Cheap filter first: most lines are long and irrelevant
  if (!line.includes(INTERRUPTED) && !line.includes('"turn_duration"')) return null;
  let rec: { type?: string; subtype?: string; isSidechain?: boolean; isMeta?: boolean; timestamp?: string; message?: { content?: unknown } };
  try {
    rec = JSON.parse(line);
  } catch {
    return null;
  }
  if (rec.isSidechain) return null; // a subagent's own turn
  const at = typeof rec.timestamp === 'string' ? rec.timestamp : undefined;
  if (rec.type === 'system' && rec.subtype === 'turn_duration') return { mark: 'ended', at };
  if (rec.type !== 'user' || rec.isMeta) return null;
  const c = rec.message?.content;
  const text = typeof c === 'string' ? c : Array.isArray(c) && c[0]?.type === 'text' ? String(c[0].text ?? '') : '';
  return text.startsWith(INTERRUPTED) ? { mark: 'interrupted', at } : null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Follows a transcript from its current end until the main turn ends or is interrupted (or maxMs passes, or the file
 * goes away). Resolves with the interrupt, or null. Reads only appended bytes, never the whole file again.
 */
export async function watchClaudeTurn(path: string, opts: { pollMs?: number; maxMs?: number } = {}): Promise<ClaudeTurnMark | null> {
  const pollMs = opts.pollMs ?? 1500;
  const until = Date.now() + (opts.maxMs ?? 2 * 60 * 60_000);
  let offset: number;
  try {
    offset = (await stat(path)).size;
  } catch {
    return null;
  }
  let rest = ''; // a line still being written
  while (Date.now() < until) {
    await sleep(pollMs);
    let size: number;
    try {
      size = (await stat(path)).size;
    } catch {
      return null; // removed
    }
    if (size < offset) return null; // rewritten — not ours to follow any more
    if (size === offset) continue;
    const file = await open(path, 'r');
    try {
      const buf = Buffer.alloc(size - offset);
      await file.read(buf, 0, buf.length, offset);
      offset = size;
      const lines = (rest + buf.toString('utf8')).split('\n');
      rest = lines.pop() ?? '';
      for (const line of lines) {
        const mark = claudeTurnMark(line);
        if (mark?.mark === 'interrupted') return mark;
        if (mark?.mark === 'ended') return null;
      }
    } finally {
      await file.close();
    }
  }
  return null;
}
