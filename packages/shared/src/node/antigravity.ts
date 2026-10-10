import { readFile, stat } from 'node:fs/promises';

// Antigravity hook payloads have no question/answer text → fill it from the transcript (transcriptPath, JSONL).
//   { step_index, type: 'USER_INPUT', content: '<USER_REQUEST>\nquestion\n</USER_REQUEST>\n<ADDITIONAL_METADATA>…' }
//   { step_index, type: 'PLANNER_RESPONSE', content: 'answer' }

type Raw = Record<string, unknown>;
interface Step {
  step_index?: number;
  type?: string;
  content?: unknown;
}

const MAX_TRANSCRIPT_BYTES = 20 * 1024 * 1024;
const RETRY_MS = 150;
const RETRIES = 6; // the hook can arrive before the transcript is written — wait a little over a second

async function readSteps(path: string): Promise<Step[]> {
  try {
    if ((await stat(path)).size > MAX_TRANSCRIPT_BYTES) return [];
    const steps: Step[] = [];
    for (const line of (await readFile(path, 'utf8')).split('\n')) {
      if (!line.trim()) continue;
      try {
        steps.push(JSON.parse(line) as Step);
      } catch {
        // last line still being written
      }
    }
    return steps;
  } catch {
    return [];
  }
}

/** Only the part the user wrote, from USER_INPUT content */
export function userRequestText(content: string): string {
  const m = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/.exec(content);
  return (m?.[1] ?? content).trim();
}

/** Payload with prompt filled for PreInvocation (first call) and last_assistant_message for Stop. Unchanged if not found */
export async function fillAntigravityText(payload: Raw): Promise<Raw> {
  const path = typeof payload.transcriptPath === 'string' ? payload.transcriptPath : undefined;
  const event = payload.hook_event_name;
  if (!path) return payload;

  if (event === 'PreInvocation' && payload.invocationNum === 0 && payload.prompt === undefined) {
    // this question is step initialNumSteps - 1
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

// ─── Approval-wait watcher (bitl-agy-watch.mjs) ──────────────────────────────────────
// Values determined by observing steps.status in the agy conversation DB (~/.gemini/antigravity-cli/conversations/<id>.db) (agy 1.2.16, not a public spec).
// If the values change, fail only toward "no notification": unknown values are ignored, and nothing is sent before seeing 9.
export const AGY_STEP = { RUNNING: 2, DONE: 3, CANCELLED: 6, REJECTED: 7, WAITING: 9 } as const;

export type AgyWatchAction = 'none' | 'waiting' | 'resolved' | 'stop';

/** What to do given one step status. waited: whether an approval wait was already reported */
export function agyWatchStep(status: number | undefined, waited: boolean): AgyWatchAction {
  if (status === AGY_STEP.WAITING) return waited ? 'none' : 'waiting';
  if (status === AGY_STEP.DONE || status === AGY_STEP.CANCELLED || status === AGY_STEP.REJECTED) return waited ? 'resolved' : 'stop';
  if (status === AGY_STEP.RUNNING && waited) return 'resolved'; // approved → running (PostToolUse arrives when it finishes)
  return 'none';
}
