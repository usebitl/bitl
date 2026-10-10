import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AGY_STEP, agyWatchStep, fillAntigravityText, userRequestText } from '../src/node/antigravity.js';

// Shape of a real agy 1.2 transcript (transcript_full.jsonl)
const transcript = [
  { step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>\n고양시 날씨는?\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: …\n</ADDITIONAL_METADATA>' },
  { step_index: 1, type: 'PLANNER_RESPONSE', content: '' },
  { step_index: 2, type: 'GENERIC', content: 'search result' },
  { step_index: 3, type: 'PLANNER_RESPONSE', content: '맑고 선선합니다.' },
  { step_index: 4, type: 'USER_INPUT', content: '<USER_REQUEST>\n디렉토리 목록 알려줘\n</USER_REQUEST>' },
];

function writeTranscript(lines: unknown[]): string {
  const path = join(mkdtempSync(join(tmpdir(), 'bitl-agy-')), 'transcript_full.jsonl');
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return path;
}

describe('filling in text from the Antigravity transcript', () => {
  const transcriptPath = writeTranscript(transcript);

  it('only the user text inside USER_REQUEST', () => {
    expect(userRequestText('<USER_REQUEST>\n  안녕\n</USER_REQUEST>\n<X>y</X>')).toBe('안녕');
    expect(userRequestText('그냥 글')).toBe('그냥 글');
  });

  it('first PreInvocation: the USER_INPUT at initialNumSteps - 1 is this question', async () => {
    const first = await fillAntigravityText({ hook_event_name: 'PreInvocation', invocationNum: 0, initialNumSteps: 1, transcriptPath });
    expect(first.prompt).toBe('고양시 날씨는?');
    const second = await fillAntigravityText({ hook_event_name: 'PreInvocation', invocationNum: 0, initialNumSteps: 5, transcriptPath });
    expect(second.prompt).toBe('디렉토리 목록 알려줘');
  });

  it('Stop: last non-empty PLANNER_RESPONSE', async () => {
    const stop = await fillAntigravityText({ hook_event_name: 'Stop', transcriptPath });
    expect(stop.last_assistant_message).toBe('맑고 선선합니다.');
  });

  it('leaves the event as is when the transcript is missing or the event does not apply', async () => {
    const missing = { hook_event_name: 'Stop', transcriptPath: join(tmpdir(), 'no-such-bitl-transcript.jsonl') };
    expect(await fillAntigravityText(missing)).toEqual(missing);
    const tool = { hook_event_name: 'PreToolUse', transcriptPath };
    expect(await fillAntigravityText(tool)).toEqual(tool);
  });
});

describe('approval wait watcher (conversation DB step status)', () => {
  // Sequences actually observed: 2 → 9 → 2 → 3 (approved), 2 → 9 → 7 (rejected), 9 → 6 (canceled by agy exit), 2 → 3 (no approval needed)
  const run = (statuses: (number | undefined)[]) => {
    let waited = false;
    const sent: string[] = [];
    for (const s of statuses) {
      const a = agyWatchStep(s, waited);
      if (a === 'waiting') waited = true;
      if (a !== 'none') sent.push(a);
      if (a === 'resolved' || a === 'stop') break;
    }
    return sent;
  };

  it('approval: waiting notice, then resolved once approved and running', () => {
    expect(run([undefined, 2, 9, 9, 2, 3])).toEqual(['waiting', 'resolved']);
  });
  it('rejection and cancellation also resolve', () => {
    expect(run([2, 9, 7])).toEqual(['waiting', 'resolved']);
    expect(run([9, 6])).toEqual(['waiting', 'resolved']);
  });
  it('a tool that finishes without approval sends nothing (even if it runs long)', () => {
    expect(run([2, 2, 2, 2, 3])).toEqual(['stop']);
    expect(run([2, AGY_STEP.REJECTED])).toEqual(['stop']);
  });
  it('ignores unknown status values', () => {
    expect(run([2, 42, 8, 3])).toEqual(['stop']);
  });
});
