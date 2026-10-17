import { type Enrichment, type EventContent, normalizeHook, type Signal, type StoredSession, splitEvent } from '@bitl/shared';
import { describe, expect, it } from 'vitest';
import { acknowledge, applyEvent, markStale } from '../src/state.js';

// The state machine doesn't read content — here unsealed plain text goes in as is to check which field it lands in
type Ev = { signal: Signal; content: EventContent };

let clock = Date.parse('2026-09-26T00:00:00.000Z');
const t = (plusSec = 1) => new Date((clock += plusSec * 1000)).toISOString();

const hook = (name: string, extra: Record<string, unknown> = {}, at = t(), enrichment: Enrichment = {}): Ev => {
  const e = normalizeHook('claude-code', { session_id: 's1', cwd: 'C:/work/api/', hook_event_name: name, ...extra }, at)!;
  const { signal, content, tagSource } = splitEvent(e, enrichment);
  return { signal: { ...signal, requestTag: tagSource }, content };
};

const step = (s: StoredSession | undefined, e: Ev) => applyEvent(s, e.signal, e.content);

/** Final session after applying events in order */
const run = (...events: Ev[]): StoredSession => {
  let s: StoredSession | undefined;
  for (const e of events) s = step(s, e).session;
  return s!;
};

/** Unwrap content fields for easy comparison */
const v = (s: StoredSession) => ({ ...s, ...s.enc });

describe('applyEvent', () => {
  it('a new session is idle; cwd and project come from the event (the adapter derives the project name from git)', () => {
    const s = run(hook('SessionStart', { source: 'startup' }, t(), { project: 'api', gitBranch: 'main' }));
    expect(v(s)).toMatchObject({ key: 'claude-code:s1', status: 'idle', cwd: 'C:/work/api/', project: 'api', gitBranch: 'main', turnCount: 0 });
  });

  it('prompt → running, the first prompt becomes the title', () => {
    const s = run(hook('UserPromptSubmit', { prompt: '로그인 버그 고쳐줘' }), hook('UserPromptSubmit', { prompt: '두번째' }));
    expect(v(s)).toMatchObject({ status: 'running', title: '로그인 버그 고쳐줘', lastPrompt: '두번째', turnCount: 2 });
  });

  it('tool use updates current activity and count', () => {
    const s = run(
      hook('UserPromptSubmit', { prompt: 'x' }),
      hook('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'pnpm test' } }),
    );
    expect(v(s)).toMatchObject({ status: 'running', currentActivity: 'Bash: pnpm test', toolCount: 1 });
  });

  it('permission wait → waiting_for_you, tool done after approval → running', () => {
    const waiting = run(
      hook('UserPromptSubmit', { prompt: 'x' }),
      hook('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'rm -rf dist' } }),
      hook('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'rm -rf dist' } }),
    );
    expect(v(waiting)).toMatchObject({ status: 'waiting_for_you', waitingReason: 'permission', currentActivity: 'Bash: rm -rf dist' });

    const resumed = step(waiting, hook('PostToolUse', { tool_name: 'Bash' })).session;
    expect(resumed.status).toBe('running');
    expect(resumed.waitingReason).toBeUndefined();
  });

  it('keeps the permission wait even if PreToolUse is stamped a few ms after PermissionRequest (async hook race)', () => {
    const at = Date.parse(t());
    const iso = (ms: number) => new Date(at + ms).toISOString();
    const s = run(
      hook('UserPromptSubmit', { prompt: 'x' }, iso(-5000)),
      hook('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'rm -rf dist' } }, iso(0)),
      hook('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'rm -rf dist' } }, iso(18)),
    );
    expect(v(s)).toMatchObject({ status: 'waiting_for_you', waitingReason: 'permission', currentActivity: 'Bash: rm -rf dist', toolCount: 1 });
    // a tool started well after the wait means the wait is over
    expect(step(s, hook('PreToolUse', { tool_name: 'Read' }, iso(5000))).session.status).toBe('running');
  });

  it('Stop → needs_review, stores the last response', () => {
    const s = run(hook('UserPromptSubmit', { prompt: 'x' }), hook('Stop', { last_assistant_message: '고쳤습니다' }));
    expect(v(s)).toMatchObject({ status: 'needs_review', lastMessage: '고쳤습니다' });
  });

  it('idle_prompt counts as needs review, not awaiting approval', () => {
    const s = run(hook('UserPromptSubmit', { prompt: 'x' }), hook('Stop'), hook('Notification', { notification_type: 'idle_prompt' }));
    expect(s.status).toBe('needs_review');
  });

  it('a late PostToolUse does not revert needs_review to running', () => {
    const prompt = hook('UserPromptSubmit', { prompt: 'x' });
    const toolAt = t();
    const stopAt = t();
    const s = run(
      prompt,
      hook('Stop', {}, stopAt),
      hook('PostToolUse', { tool_name: 'Bash' }, toolAt), // happened before Stop but arrived later
    );
    expect(s.status).toBe('needs_review');
  });

  it('a subagent Stop does not end the parent turn', () => {
    const s = run(
      hook('UserPromptSubmit', { prompt: 'x' }),
      hook('SubagentStart', { agent_id: 'a1', agent_type: 'Explore' }),
      hook('PreToolUse', { agent_id: 'a1', agent_type: 'Explore', tool_name: 'Grep', tool_input: { pattern: 'foo' } }),
      hook('Stop', { agent_id: 'a1', agent_type: 'Explore' }),
    );
    expect(v(s)).toMatchObject({ status: 'running', subagentsRunning: 1, currentActivity: '[Explore] Grep: foo' });
    expect(step(s, hook('SubagentStop', { agent_id: 'a1', agent_type: 'Explore' })).session.subagentsRunning).toBe(0);
  });

  it('internal subagents with an empty agent_type are not counted', () => {
    const s = run(hook('SubagentStop', { agent_id: 'x', agent_type: '' }));
    expect(s.subagentsRunning).toBe(0);
  });

  it('a cleared card comes back when the agent works or needs the user, not on notices, the idle reminder or the end', () => {
    const done = { ...run(hook('UserPromptSubmit', { prompt: 'x' }), hook('Stop')), cleared: true };
    for (const quiet of [
      hook('Notification', { notification_type: 'idle_prompt' }),
      hook('PreCompact', { trigger: 'auto' }),
      hook('SessionEnd', { reason: 'other' }),
    ])
      expect(step(done, quiet).session.cleared).toBe(true);
    expect(step(done, hook('UserPromptSubmit', { prompt: 'y' })).session.cleared).toBeUndefined();
    expect(step(done, hook('PermissionRequest', { tool_name: 'Bash', tool_input: {} })).session.cleared).toBeUndefined();
  });

  it('StopFailure → error, SessionEnd → ended, restart → idle', () => {
    const err = run(hook('UserPromptSubmit', { prompt: 'x' }), hook('StopFailure', { error_type: 'rate_limit' }));
    expect(v(err)).toMatchObject({ status: 'error', lastMessage: 'rate_limit' });
    const ended = step(err, hook('SessionEnd', { reason: 'other' })).session;
    expect(ended.status).toBe('ended');
    expect(ended.endedAt).toBeDefined();
    const back = step(ended, hook('SessionStart', { source: 'resume' })).session;
    expect(back.status).toBe('idle');
    expect(back.endedAt).toBeUndefined();
  });

  it('also returns the turn change', () => {
    const start = step(undefined, hook('UserPromptSubmit', { prompt: 'p', prompt_id: 'p1' }));
    expect(start.turns).toEqual([expect.objectContaining({ op: 'start', turnId: 'p1', prompt: 'p' })]);
    const end = step(start.session, hook('Stop', { prompt_id: 'p1', last_assistant_message: 'r' }));
    expect(end.turns).toEqual([expect.objectContaining({ op: 'end', turnId: 'p1', result: 'r', status: 'done' })]);
  });

  it('CwdChanged moves to the new location; extras not included stay as they are', () => {
    const s = run(hook('SessionStart', {}, t(), { project: 'api' }), hook('CwdChanged', { new_cwd: 'C:/work/api/packages/web' }));
    expect(v(s)).toMatchObject({ cwd: 'C:/work/api/packages/web', project: 'api' });
  });

  it('tool events without cwd do not clear the existing value', () => {
    const s = run(hook('UserPromptSubmit', { prompt: 'x' }), hook('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } }));
    expect(s.enc.cwd).toBe('C:/work/api/');
  });
});

describe('markStale / acknowledge', () => {
  it('running with no news for 10 minutes → stale; waiting states stay', () => {
    const running = run(hook('UserPromptSubmit', { prompt: 'x' }));
    const later = new Date(Date.parse(running.lastEventAt) + 11 * 60_000);
    expect(markStale(running, later)?.status).toBe('stale');
    expect(markStale(running, new Date(Date.parse(running.lastEventAt) + 60_000))).toBeNull();

    const waiting = step(running, hook('PermissionRequest', { tool_name: 'Bash' })).session;
    expect(markStale(waiting, later)).toBeNull();
  });

  it('needs review → acknowledge → idle; running cannot be acknowledged', () => {
    const review = run(hook('UserPromptSubmit', { prompt: 'x' }), hook('Stop'));
    expect(acknowledge(review, new Date())?.status).toBe('idle');
    expect(acknowledge(run(hook('UserPromptSubmit', { prompt: 'x' })), new Date())).toBeNull();
  });
});

describe('waiting on questions and plan approval', () => {
  it('AskUserQuestion: asking → waiting for you, answering → running again, never stale while waiting', () => {
    const asking = run(
      hook('UserPromptSubmit', { prompt: 'DB 설계해줘' }),
      hook('PreToolUse', { tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: '어느 DB?' }] } }),
    );
    expect(v(asking)).toMatchObject({ status: 'waiting_for_you', waitingReason: 'question', currentActivity: 'AskUserQuestion: 어느 DB?' });
    expect(markStale(asking, new Date(Date.parse(asking.lastEventAt) + 60 * 60_000))).toBeNull();

    const answered = step(asking, hook('PostToolUse', { tool_name: 'AskUserQuestion' })).session;
    expect(answered.status).toBe('running');
    expect(answered.waitingReason).toBeUndefined();
  });

  it('ExitPlanMode: waiting on plan approval → back to running even if rejected (failed)', () => {
    const planning = run(hook('UserPromptSubmit', { prompt: 'x' }), hook('PreToolUse', { tool_name: 'ExitPlanMode', tool_input: { plan: 'p' } }));
    expect(v(planning)).toMatchObject({ status: 'waiting_for_you', waitingReason: 'plan' });
    expect(step(planning, hook('PostToolUseFailure', { tool_name: 'ExitPlanMode' })).session.status).toBe('running');
  });
});
