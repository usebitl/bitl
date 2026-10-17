// Codex hooks (https://learn.chatgpt.com/docs/hooks) — shapes from real dumps (codex-cli 0.160), content made up.
// Same event names as Claude Code, plus turn_id on every turn event and Interrupt. No Notification, StopFailure or subagent hooks
import type { AgentFixture } from '../scenarios.js';
import { recorder } from './record.js';

const cx = () =>
  recorder('codex', {
    session_id: '01a10049-a4c4-7d61-a34e-000000000001',
    transcript_path: 'C:/Users/me/.codex/sessions/2026/10/18/rollout-01a10049.jsonl',
    cwd: 'C:/w/api',
    model: 'gpt-6-luna',
    permission_mode: 'default',
  });

const turn = { turn_id: '01a1004a-f4d8-71a2-97e3-000000000001' };
const bash = { ...turn, tool_name: 'Bash', tool_input: { command: ['bash', '-lc', 'pnpm test'] }, tool_use_id: 'exec-1' };

export const codex: AgentFixture = {
  agent: 'Codex',

  'basic-turn': (() => {
    const ev = cx();
    return {
      steps: {
        'session starts': [ev({ hook_event_name: 'SessionStart', source: 'startup' })],
        'user gives an instruction': [ev({ hook_event_name: 'UserPromptSubmit', ...turn, prompt: 'Fix the login bug' })],
        'a tool starts': [ev({ hook_event_name: 'PreToolUse', ...bash })],
        'the tool finishes': [ev({ hook_event_name: 'PostToolUse', ...bash, tool_response: ['ok'] })],
        'the turn ends': [ev({ hook_event_name: 'Stop', ...turn, stop_hook_active: false, last_assistant_message: 'Fixed it' })],
      },
    };
  })(),

  'permission-wait': (() => {
    const ev = cx();
    return {
      steps: {
        'user gives an instruction': [ev({ hook_event_name: 'UserPromptSubmit', ...turn, prompt: 'Deploy it' })],
        'the agent asks to run a tool': [ev({ hook_event_name: 'PreToolUse', ...bash }), ev({ hook_event_name: 'PermissionRequest', ...bash }, 40)],
        'the user allows it and the tool finishes': [ev({ hook_event_name: 'PostToolUse', ...bash }, 6000)],
        'the turn ends': [ev({ hook_event_name: 'Stop', ...turn, last_assistant_message: 'Done' })],
      },
    };
  })(),

  // Seen in Codex: PreToolUse stamped 18 ms after PermissionRequest
  'permission-race': (() => {
    const ev = cx();
    return {
      steps: {
        'user gives an instruction': [ev({ hook_event_name: 'UserPromptSubmit', ...turn, prompt: 'Deploy it' })],
        'approval request, then the same tool start a few ms later': [ev({ hook_event_name: 'PermissionRequest', ...bash }), ev({ hook_event_name: 'PreToolUse', ...bash }, 18)],
        'the user allows it and the tool finishes': [ev({ hook_event_name: 'PostToolUse', ...bash }, 6000)],
      },
    };
  })(),

  question: { unverified: "Does Codex have a tool that stops to ask the user, and does it reach hooks? Try a prompt that makes Codex ask a choice and dump the hooks" },

  'late-event': (() => {
    const ev = cx();
    return {
      steps: {
        'instruction and a tool start': [ev({ hook_event_name: 'UserPromptSubmit', ...turn, prompt: 'Fix it' }), ev({ hook_event_name: 'PreToolUse', ...bash })],
        'the turn ends': [ev({ hook_event_name: 'Stop', ...turn, last_assistant_message: 'Done' }, 2000)],
        'the tool end arrives late (older timestamp)': [ev({ hook_event_name: 'PostToolUse', ...bash }, -500)],
      },
    };
  })(),

  'idle-reminder': { unsupported: 'Codex has no Notification hook — nothing reminds after a turn' },

  interrupt: (() => {
    const ev = cx();
    return {
      steps: {
        'instruction and a tool start': [ev({ hook_event_name: 'UserPromptSubmit', ...turn, prompt: 'Refactor' }), ev({ hook_event_name: 'PreToolUse', ...bash })],
        'the user interrupts': [ev({ hook_event_name: 'Interrupt', ...turn })],
      },
    };
  })(),

  error: { unverified: 'Codex has no StopFailure hook. What arrives when a turn fails (rate limit, network)? Force a failure and dump the hooks' },

  subagent: { unverified: 'Codex has no subagent hooks. Check whether delegated work (if any) shows up as separate sessions' },

  'session-end-and-resume': (() => {
    const ev = cx();
    return {
      steps: {
        'instruction, then the turn ends': [ev({ hook_event_name: 'UserPromptSubmit', ...turn, prompt: 'Fix it' }), ev({ hook_event_name: 'Stop', ...turn, last_assistant_message: 'Done' })],
        'the session ends': [ev({ hook_event_name: 'SessionEnd', reason: 'other' })],
        'the session is reopened': [ev({ hook_event_name: 'SessionStart', source: 'resume' })],
      },
    };
  })(),

  'relay-only-session': { unsupported: 'Codex has no Notification hook, so no session relays notifications about others' },

  'cleared-comes-back': (() => {
    const ev = cx();
    return {
      steps: {
        'instruction, then the turn ends, and the user clears': [ev({ hook_event_name: 'UserPromptSubmit', ...turn, prompt: 'Fix it' }), ev({ hook_event_name: 'Stop', ...turn, last_assistant_message: 'Done' })],
        'a quiet event arrives': [ev({ hook_event_name: 'SessionStart', source: 'resume' })],
        'the user gives a new instruction': [ev({ hook_event_name: 'UserPromptSubmit', turn_id: '01a1004a-0000-0000-0000-000000000002', prompt: 'One more thing' })],
      },
    };
  })(),

  // Codex's auto-review (guardian) settles most approvals itself, but PermissionRequest fires before it decides —
  // the payload has no sign of the auto-review, so the card shows "waiting for you" (and pushes) for ~10 s. Fix idea: read the real state on the PC (session rollout), or hold Codex approval pushes ~20 s
  'no-false-wait': (() => {
    const ev = cx();
    return {
      knownGap: {
        at: 'an approval request the agent answers itself',
        why: 'PermissionRequest arrives before the auto-review decides and carries no sign of it — a false "waiting for you" for ~10 s',
      },
      steps: {
        'user gives an instruction': [ev({ hook_event_name: 'UserPromptSubmit', ...turn, prompt: 'Fix it' })],
        'an approval request the agent answers itself': [ev({ hook_event_name: 'PreToolUse', ...bash }), ev({ hook_event_name: 'PermissionRequest', ...bash }, 30)],
        'the tool finishes': [ev({ hook_event_name: 'PostToolUse', ...bash }, 10_000)],
      },
    };
  })(),
};
