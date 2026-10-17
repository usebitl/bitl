// Claude Code hooks (https://code.claude.com/docs/en/hooks) — shapes from real dumps, content made up
import type { AgentFixture } from '../scenarios.js';
import { recorder } from './record.js';

const cc = () =>
  recorder('claude-code', {
    session_id: '3f6c2a1e-0000-4000-8000-000000000001',
    transcript_path: 'C:/Users/me/.claude/projects/C--w-api/3f6c2a1e.jsonl',
    cwd: 'C:/w/api',
    permission_mode: 'default',
  });

const bash = { tool_name: 'Bash', tool_input: { command: 'pnpm test', description: 'Run tests' }, tool_use_id: 'toolu_01' };

export const claudeCode: AgentFixture = {
  agent: 'Claude Code',

  'basic-turn': (() => {
    const ev = cc();
    return {
      steps: {
        'session starts': [ev({ hook_event_name: 'SessionStart', source: 'startup' })],
        'user gives an instruction': [ev({ hook_event_name: 'UserPromptSubmit', prompt: 'Fix the login bug' })],
        'a tool starts': [ev({ hook_event_name: 'PreToolUse', ...bash })],
        'the tool finishes': [ev({ hook_event_name: 'PostToolUse', ...bash, tool_response: { stdout: 'ok' } })],
        'the turn ends': [ev({ hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'Fixed it' })],
      },
    };
  })(),

  'permission-wait': (() => {
    const ev = cc();
    return {
      steps: {
        'user gives an instruction': [ev({ hook_event_name: 'UserPromptSubmit', prompt: 'Deploy it' })],
        'the agent asks to run a tool': [ev({ hook_event_name: 'PreToolUse', ...bash }), ev({ hook_event_name: 'PermissionRequest', ...bash }, 30)],
        'the user allows it and the tool finishes': [ev({ hook_event_name: 'PostToolUse', ...bash }, 5000)],
        'the turn ends': [ev({ hook_event_name: 'Stop', last_assistant_message: 'Done' })],
      },
    };
  })(),

  'permission-race': (() => {
    const ev = cc();
    return {
      steps: {
        'user gives an instruction': [ev({ hook_event_name: 'UserPromptSubmit', prompt: 'Deploy it' })],
        'approval request, then the same tool start a few ms later': [ev({ hook_event_name: 'PermissionRequest', ...bash }), ev({ hook_event_name: 'PreToolUse', ...bash }, 18)],
        'the user allows it and the tool finishes': [ev({ hook_event_name: 'PostToolUse', ...bash }, 5000)],
      },
    };
  })(),

  question: (() => {
    const ev = cc();
    const ask = { tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Which database?', options: [] }] }, tool_use_id: 'toolu_q' };
    return {
      steps: {
        'user gives an instruction': [ev({ hook_event_name: 'UserPromptSubmit', prompt: 'Set up storage' })],
        'the agent asks a question': [ev({ hook_event_name: 'PreToolUse', ...ask })],
        'the user answers': [ev({ hook_event_name: 'PostToolUse', ...ask }, 20_000)],
      },
    };
  })(),

  'late-event': (() => {
    const ev = cc();
    return {
      steps: {
        'instruction and a tool start': [ev({ hook_event_name: 'UserPromptSubmit', prompt: 'Fix it' }), ev({ hook_event_name: 'PreToolUse', ...bash })],
        'the turn ends': [ev({ hook_event_name: 'Stop', last_assistant_message: 'Done' }, 2000)],
        'the tool end arrives late (older timestamp)': [ev({ hook_event_name: 'PostToolUse', ...bash }, -500)],
      },
    };
  })(),

  'idle-reminder': (() => {
    const ev = cc();
    return {
      steps: {
        'instruction, then the turn ends': [ev({ hook_event_name: 'UserPromptSubmit', prompt: 'Fix it' }), ev({ hook_event_name: 'Stop', last_assistant_message: 'Done' })],
        'the idle reminder arrives': [ev({ hook_event_name: 'Notification', notification_type: 'idle_prompt', message: 'Claude is waiting for your input' }, 60_000)],
      },
    };
  })(),

  interrupt: (() => {
    const ev = cc();
    return {
      // Claude Code sends no hook on interrupt (Esc while it answers — checked on 2.1.302, 2026-10-18). The watcher the
      // prompt hook starts (bitl-cc-watch.mjs) reads "[Request interrupted by user]" from the transcript and sends this.
      // (Esc while a Bash command runs moves the command to the background instead, and the turn ends with Stop.)
      steps: {
        'instruction and a tool start': [ev({ hook_event_name: 'UserPromptSubmit', prompt: 'Refactor' }), ev({ hook_event_name: 'PreToolUse', ...bash })],
        'the user interrupts': [ev({ hook_event_name: 'bitl:Interrupted' }, 90_000)],
      },
    };
  })(),

  error: (() => {
    const ev = cc();
    return {
      steps: {
        'user gives an instruction': [ev({ hook_event_name: 'UserPromptSubmit', prompt: 'Fix it' })],
        'the turn fails': [ev({ hook_event_name: 'StopFailure', error_type: 'rate_limit' })],
      },
    };
  })(),

  subagent: (() => {
    const ev = cc();
    const inside = { agent_id: 'agent_7', agent_type: 'Explore' };
    return {
      steps: {
        'user gives an instruction': [ev({ hook_event_name: 'UserPromptSubmit', prompt: 'Find the bug' })],
        'a named subagent starts': [ev({ hook_event_name: 'SubagentStart', ...inside })],
        'the subagent works and finishes its own turn': [
          ev({ hook_event_name: 'PreToolUse', ...bash, ...inside }),
          ev({ hook_event_name: 'PostToolUse', ...bash, ...inside }),
          ev({ hook_event_name: 'Stop', ...inside, last_assistant_message: 'Found it' }),
        ],
        'the subagent stops': [ev({ hook_event_name: 'SubagentStop', ...inside, last_assistant_message: 'Found it' })],
        'an internal (unnamed) subagent comes and goes': [
          ev({ hook_event_name: 'SubagentStart', agent_id: 'agent_8', agent_type: '' }),
          ev({ hook_event_name: 'SubagentStop', agent_id: 'agent_8', agent_type: '' }),
        ],
      },
    };
  })(),

  'session-end-and-resume': (() => {
    const ev = cc();
    return {
      steps: {
        'instruction, then the turn ends': [ev({ hook_event_name: 'UserPromptSubmit', prompt: 'Fix it' }), ev({ hook_event_name: 'Stop', last_assistant_message: 'Done' })],
        'the session ends': [ev({ hook_event_name: 'SessionEnd', reason: 'prompt_input_exit' })],
        'the session is reopened': [ev({ hook_event_name: 'SessionStart', source: 'resume' })],
      },
    };
  })(),

  'relay-only-session': (() => {
    const ev = cc();
    return {
      steps: {
        'the session starts': [ev({ hook_event_name: 'SessionStart', source: 'startup' })],
        'it relays another session needing input': [ev({ hook_event_name: 'Notification', notification_type: 'agent_needs_input', message: 'Another session needs your input' })],
      },
    };
  })(),

  'cleared-comes-back': (() => {
    const ev = cc();
    return {
      steps: {
        'instruction, then the turn ends, and the user clears': [ev({ hook_event_name: 'UserPromptSubmit', prompt: 'Fix it' }), ev({ hook_event_name: 'Stop', last_assistant_message: 'Done' })],
        'a quiet event arrives': [
          ev({ hook_event_name: 'Notification', notification_type: 'idle_prompt', message: 'Claude is waiting for your input' }, 60_000),
          ev({ hook_event_name: 'CwdChanged', old_cwd: 'C:/w/api', new_cwd: 'C:/w/web' }),
        ],
        'the user gives a new instruction': [ev({ hook_event_name: 'UserPromptSubmit', prompt: 'One more thing' })],
      },
    };
  })(),

  // In auto/accept modes Claude Code runs the tool without asking — no PermissionRequest is sent
  'no-false-wait': (() => {
    const ev = cc();
    return {
      steps: {
        'user gives an instruction': [ev({ hook_event_name: 'UserPromptSubmit', prompt: 'Fix it' })],
        'an approval request the agent answers itself': [ev({ hook_event_name: 'PreToolUse', ...bash })],
        'the tool finishes': [ev({ hook_event_name: 'PostToolUse', ...bash })],
      },
    };
  })(),
};
