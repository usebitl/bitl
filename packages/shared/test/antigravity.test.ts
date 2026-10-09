import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AGY_STEP, agyWatchStep, fillAntigravityText, userRequestText } from '../src/node/antigravity.js';

// 실제 agy 1.2 트랜스크립트(transcript_full.jsonl) 모양
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

describe('Antigravity 트랜스크립트에서 원문 채우기', () => {
  const transcriptPath = writeTranscript(transcript);

  it('USER_REQUEST 안의 사용자 글만', () => {
    expect(userRequestText('<USER_REQUEST>\n  안녕\n</USER_REQUEST>\n<X>y</X>')).toBe('안녕');
    expect(userRequestText('그냥 글')).toBe('그냥 글');
  });

  it('첫 PreInvocation: initialNumSteps - 1 번째 USER_INPUT 이 이번 질문', async () => {
    const first = await fillAntigravityText({ hook_event_name: 'PreInvocation', invocationNum: 0, initialNumSteps: 1, transcriptPath });
    expect(first.prompt).toBe('고양시 날씨는?');
    const second = await fillAntigravityText({ hook_event_name: 'PreInvocation', invocationNum: 0, initialNumSteps: 5, transcriptPath });
    expect(second.prompt).toBe('디렉토리 목록 알려줘');
  });

  it('Stop: 비어 있지 않은 마지막 PLANNER_RESPONSE', async () => {
    const stop = await fillAntigravityText({ hook_event_name: 'Stop', transcriptPath });
    expect(stop.last_assistant_message).toBe('맑고 선선합니다.');
  });

  it('트랜스크립트가 없거나 해당 없는 이벤트는 그대로', async () => {
    const missing = { hook_event_name: 'Stop', transcriptPath: join(tmpdir(), 'no-such-bitl-transcript.jsonl') };
    expect(await fillAntigravityText(missing)).toEqual(missing);
    const tool = { hook_event_name: 'PreToolUse', transcriptPath };
    expect(await fillAntigravityText(tool)).toEqual(tool);
  });
});

describe('승인 대기 감시 (대화 DB 단계 상태)', () => {
  // 실제로 본 순서: 2 → 9 → 2 → 3 (승인), 2 → 9 → 7 (거부), 9 → 6 (agy 종료로 취소), 2 → 3 (승인 필요 없음)
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

  it('승인: 대기 알림 → 승인되어 실행되면 해제', () => {
    expect(run([undefined, 2, 9, 9, 2, 3])).toEqual(['waiting', 'resolved']);
  });
  it('거부·취소도 해제', () => {
    expect(run([2, 9, 7])).toEqual(['waiting', 'resolved']);
    expect(run([9, 6])).toEqual(['waiting', 'resolved']);
  });
  it('승인 없이 끝난 도구는 아무것도 보내지 않는다 (오래 실행돼도)', () => {
    expect(run([2, 2, 2, 2, 3])).toEqual(['stop']);
    expect(run([2, AGY_STEP.REJECTED])).toEqual(['stop']);
  });
  it('모르는 상태 값은 무시', () => {
    expect(run([2, 42, 8, 3])).toEqual(['stop']);
  });
});
