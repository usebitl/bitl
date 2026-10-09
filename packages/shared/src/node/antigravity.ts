import { readFile, stat } from 'node:fs/promises';

// Antigravity hook 페이로드에는 질문·답변 원문이 없다 → 트랜스크립트(transcriptPath, JSONL)에서 채운다.
//   { step_index, type: 'USER_INPUT', content: '<USER_REQUEST>\n질문\n</USER_REQUEST>\n<ADDITIONAL_METADATA>…' }
//   { step_index, type: 'PLANNER_RESPONSE', content: '답변' }

type Raw = Record<string, unknown>;
interface Step {
  step_index?: number;
  type?: string;
  content?: unknown;
}

const MAX_TRANSCRIPT_BYTES = 20 * 1024 * 1024;
const RETRY_MS = 150;
const RETRIES = 6; // hook 이 트랜스크립트 기록보다 먼저 올 수 있다 — 1초 남짓 기다린다

async function readSteps(path: string): Promise<Step[]> {
  try {
    if ((await stat(path)).size > MAX_TRANSCRIPT_BYTES) return [];
    const steps: Step[] = [];
    for (const line of (await readFile(path, 'utf8')).split('\n')) {
      if (!line.trim()) continue;
      try {
        steps.push(JSON.parse(line) as Step);
      } catch {
        // 쓰는 중인 마지막 줄
      }
    }
    return steps;
  } catch {
    return [];
  }
}

/** USER_INPUT content 에서 사용자가 쓴 부분만 */
export function userRequestText(content: string): string {
  const m = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/.exec(content);
  return (m?.[1] ?? content).trim();
}

/** PreInvocation(첫 호출)에는 prompt, Stop 에는 last_assistant_message 를 채운 페이로드. 못 찾으면 그대로 */
export async function fillAntigravityText(payload: Raw): Promise<Raw> {
  const path = typeof payload.transcriptPath === 'string' ? payload.transcriptPath : undefined;
  const event = payload.hook_event_name;
  if (!path) return payload;

  if (event === 'PreInvocation' && payload.invocationNum === 0 && payload.prompt === undefined) {
    // 이번 질문은 initialNumSteps - 1 번째 단계
    const index = typeof payload.initialNumSteps === 'number' ? payload.initialNumSteps - 1 : undefined;
    for (let i = 0; i <= RETRIES; i++) {
      const steps = await readSteps(path);
      const input = steps.filter((s) => s.type === 'USER_INPUT' && (index === undefined || s.step_index === index)).at(-1);
      if (typeof input?.content === 'string') return { ...payload, prompt: userRequestText(input.content) };
      await new Promise((r) => setTimeout(r, RETRY_MS));
    }
    return payload;
  }

  if (event === 'Stop' && payload.last_assistant_message === undefined) {
    const steps = await readSteps(path);
    const reply = steps.filter((s) => s.type === 'PLANNER_RESPONSE' && typeof s.content === 'string' && s.content.trim()).at(-1);
    return reply ? { ...payload, last_assistant_message: (reply.content as string).trim() } : payload;
  }
  return payload;
}

// ─── 승인 대기 감시 (bitl-agy-watch.mjs) ──────────────────────────────────────
// agy 대화 DB(~/.gemini/antigravity-cli/conversations/<id>.db)의 steps.status 를 관찰해 정한 값 (agy 1.2.16, 공개 규격 아님).
// 값이 바뀌면 "알림이 오지 않는" 쪽으로만 틀리게: 모르는 값은 무시하고, 9 를 보기 전에는 아무것도 보내지 않는다.
export const AGY_STEP = { RUNNING: 2, DONE: 3, CANCELLED: 6, REJECTED: 7, WAITING: 9 } as const;

export type AgyWatchAction = 'none' | 'waiting' | 'resolved' | 'stop';

/** 단계 상태 하나를 보고 할 일. waited: 이미 승인 대기를 알렸는가 */
export function agyWatchStep(status: number | undefined, waited: boolean): AgyWatchAction {
  if (status === AGY_STEP.WAITING) return waited ? 'none' : 'waiting';
  if (status === AGY_STEP.DONE || status === AGY_STEP.CANCELLED || status === AGY_STEP.REJECTED) return waited ? 'resolved' : 'stop';
  if (status === AGY_STEP.RUNNING && waited) return 'resolved'; // 승인됨 → 실행 중 (끝나면 PostToolUse 가 온다)
  return 'none';
}
