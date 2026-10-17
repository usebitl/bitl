import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeHook } from '../src/normalize.js';
import { findResumedFrom, resumedFromFor } from '../src/node/resume.js';
import { splitEvent } from '../src/prepare.js';

const SID = {
  a: 'aaaaaaaa-0000-4000-8000-000000000000',
  b: 'bbbbbbbb-0000-4000-8000-000000000000',
  c: 'cccccccc-0000-4000-8000-000000000000',
};
const msg = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** A project folder of transcripts: name → message numbers (each a line with its uuid, as Claude Code writes them) */
function project(files: Record<string, number[]>) {
  const dir = mkdtempSync(join(tmpdir(), 'transcripts-'));
  for (const [id, msgs] of Object.entries(files)) {
    const lines = [{ type: 'custom-title', customTitle: 't', sessionId: id }, ...msgs.map((n, i) => ({ parentUuid: i ? msg(msgs[i - 1]!) : null, uuid: msg(n), sessionId: id }))];
    writeFileSync(join(dir, `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  }
  return (id: string) => join(dir, `${id}.jsonl`);
}

describe('findResumedFrom', () => {
  it('finds the transcript the copied messages came from — right after the copy and after new messages', async () => {
    const at = project({ [SID.a]: [1, 2, 3], [SID.b]: [1, 2, 3] });
    expect(await findResumedFrom(at(SID.b))).toBe(SID.a);
    const later = project({ [SID.a]: [1, 2, 3], [SID.b]: [1, 2, 3, 4, 5] });
    expect(await findResumedFrom(later(SID.b))).toBe(SID.a);
  });

  it('the session that was copied is not taken for a continuation of its copy', async () => {
    const at = project({ [SID.a]: [1, 2, 3], [SID.b]: [1, 2, 3, 4] });
    expect(await findResumedFrom(at(SID.a))).toBeNull();
  });

  it('a chain points at the latest step, and of two forks each points at the original', async () => {
    const chain = project({ [SID.a]: [1, 2], [SID.b]: [1, 2, 3, 4], [SID.c]: [1, 2, 3, 4, 5] });
    expect(await findResumedFrom(chain(SID.c))).toBe(SID.b);
    const forks = project({ [SID.a]: [1, 2], [SID.b]: [1, 2, 3], [SID.c]: [1, 2, 6] });
    expect(await findResumedFrom(forks(SID.c))).toBe(SID.a);
  });

  it('a plain session continues none; no messages yet means "can\'t tell"', async () => {
    const at = project({ [SID.a]: [1, 2], [SID.b]: [7, 8], [SID.c]: [] });
    expect(await findResumedFrom(at(SID.b))).toBeNull();
    expect(await findResumedFrom(at(SID.c))).toBeUndefined();
  });
});

describe('resumedFromFor', () => {
  const hook = (name: string, transcript: string, extra: Record<string, unknown> = {}) =>
    normalizeHook('claude-code', { session_id: SID.b, cwd: 'C:/w', transcript_path: transcript, hook_event_name: name, ...extra }, '2026-10-17T00:00:00.000Z')!;

  it('looks only at a resumed SessionStart, caches the answer, and retries at the first prompt if the transcript was empty', async () => {
    const home = mkdtempSync(join(tmpdir(), 'bitl-home-'));
    const at = project({ [SID.a]: [1, 2], [SID.b]: [] });
    // A plain start is never scanned
    expect(await resumedFromFor(hook('SessionStart', at(SID.b), { source: 'startup' }), home)).toBeUndefined();
    // Resumed, but nothing copied yet → pending
    expect(await resumedFromFor(hook('SessionStart', at(SID.b), { source: 'resume' }), home)).toBeUndefined();
    writeFileSync(at(SID.b), [1, 2, 3].map((n) => JSON.stringify({ uuid: msg(n) })).join('\n'));
    expect(await resumedFromFor(hook('UserPromptSubmit', at(SID.b), { prompt: 'x' }), home)).toBe(SID.a);
    // From then on every event answers from the cache
    expect(await resumedFromFor(hook('PreToolUse', at(SID.b), { tool_name: 'Bash', tool_input: {} }), home)).toBe(SID.a);
    expect(JSON.parse(readFileSync(join(home, 'resume-links.json'), 'utf8'))[SID.b]).toMatchObject({ from: SID.a });
  });

  it('goes into the signal, never the sealed content', () => {
    const e = normalizeHook('claude-code', { session_id: SID.b, cwd: 'C:/w', hook_event_name: 'UserPromptSubmit', prompt: 'x' }, '2026-10-17T00:00:00.000Z')!;
    const { signal, content } = splitEvent(e, { resumedFrom: SID.a, project: 'w' });
    expect(signal.resumedFrom).toBe(SID.a);
    expect(content).not.toHaveProperty('resumedFrom');
    expect(content.project).toBe('w');
  });
});
