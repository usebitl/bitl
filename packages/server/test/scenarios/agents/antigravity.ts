// Antigravity (agy) hooks (https://antigravity.google/docs/hooks/) — shapes from real dumps (agy 1.2.16), content made up.
// The adapter puts the event name (--event) into hook_event_name and fills prompt/last_assistant_message from the transcript.
// Only PreInvocation, PreToolUse, PostToolUse, PostInvocation, Stop exist: no session start/end, approval or notification hooks.
// Approval waits come from bitl-agy-watch.mjs (the conversation DB): bitl:PermissionWaiting / bitl:PermissionResolved
import type { AgentFixture } from '../scenarios.js';
import { recorder } from './record.js';

const agy = () =>
  recorder('antigravity', {
    conversationId: '0e9971d9-7b9e-4ae4-9ef1-000000000001',
    transcriptPath: 'C:/Users/me/.gemini/antigravity-cli/brain/0e9971d9/transcript.jsonl',
    artifactDirectoryPath: 'C:/Users/me/.gemini/antigravity-cli/brain/0e9971d9',
    workspacePaths: ['C:/w/api'],
    modelName: 'gemini-3.8-flash-high',
  });

const run = { toolCall: { name: 'run_command', args: { CommandLine: 'pnpm test', Cwd: 'C:/w/api', toolAction: 'Run tests', toolSummary: 'Running tests' } } };
const prompt = (text: string) => ({ hook_event_name: 'PreInvocation', invocationNum: 0, initialNumSteps: 1, prompt: text });
const stop = (text: string) => ({ hook_event_name: 'Stop', executionNum: 0, fullyIdle: true, terminationReason: 'NO_TOOL_CALL', error: '', last_assistant_message: text });

export const antigravity: AgentFixture = {
  agent: 'Antigravity',

  'basic-turn': (() => {
    const ev = agy();
    return {
      steps: {
        'session starts': null, // no session start hook: the card appears with the first instruction
        'user gives an instruction': [ev(prompt('Fix the login bug'))],
        'a tool starts': [ev({ hook_event_name: 'PreToolUse', stepIdx: 2, ...run })],
        'the tool finishes': [
          ev({ hook_event_name: 'PostToolUse', stepIdx: 2, error: '', ...run }),
          // Later model calls within the same turn are dropped (only invocationNum 0 is the user's question)
          ev({ hook_event_name: 'PreInvocation', invocationNum: 1, initialNumSteps: 3 }),
          ev({ hook_event_name: 'PostInvocation', invocationNum: 1, initialNumSteps: 3 }),
        ],
        'the turn ends': [ev(stop('Fixed it'))],
      },
    };
  })(),

  'permission-wait': (() => {
    const ev = agy();
    return {
      steps: {
        'user gives an instruction': [ev(prompt('Deploy it'))],
        // PreToolUse fires before the approval prompt; the watcher sees the step waiting in the conversation DB
        'the agent asks to run a tool': [ev({ hook_event_name: 'PreToolUse', stepIdx: 2, ...run }), ev({ hook_event_name: 'bitl:PermissionWaiting', ...run }, 300)],
        'the user allows it and the tool finishes': [ev({ hook_event_name: 'bitl:PermissionResolved' }, 5000), ev({ hook_event_name: 'PostToolUse', stepIdx: 2, error: '', ...run })],
        'the turn ends': [ev(stop('Done'))],
      },
    };
  })(),

  'permission-race': { unsupported: 'The approval wait comes from the DB watcher, always after the tool start — no hook race' },

  question: { unverified: 'Does agy have a tool that stops to ask the user? Try a prompt that makes it ask a choice and dump the hooks and the conversation DB' },

  'late-event': (() => {
    const ev = agy();
    return {
      steps: {
        'instruction and a tool start': [ev(prompt('Fix it')), ev({ hook_event_name: 'PreToolUse', stepIdx: 2, ...run })],
        'the turn ends': [ev(stop('Done'), 2000)],
        'the tool end arrives late (older timestamp)': [ev({ hook_event_name: 'PostToolUse', stepIdx: 2, error: '', ...run }, -500)],
      },
    };
  })(),

  'idle-reminder': { unsupported: 'No notification hook — nothing reminds after a turn' },

  interrupt: { unverified: 'What arrives when the user stops agy mid-turn (Stop with a terminationReason? nothing?). Interrupt a long task and dump the hooks' },

  error: (() => {
    const ev = agy();
    return {
      steps: {
        'user gives an instruction': [ev(prompt('Fix it'))],
        'the turn fails': [ev({ hook_event_name: 'Stop', executionNum: 0, fullyIdle: true, terminationReason: 'ERROR', error: 'quota exceeded' })],
      },
    };
  })(),

  subagent: { unsupported: 'No subagent hooks' },

  'session-end-and-resume': { unsupported: 'No session start/end hooks — a conversation never shows as ended' },

  'relay-only-session': { unsupported: 'No notification hook, so no session relays notifications about others' },

  'cleared-comes-back': (() => {
    const ev = agy();
    return {
      steps: {
        'instruction, then the turn ends, and the user clears': [ev(prompt('Fix it')), ev(stop('Done'))],
        'a quiet event arrives': [ev({ hook_event_name: 'PostInvocation', invocationNum: 0, initialNumSteps: 1 })],
        'the user gives a new instruction': [ev(prompt('One more thing'))],
      },
    };
  })(),

  // Tools agy runs without asking: the watcher never sees a waiting step, so nothing but tool start/end arrives
  'no-false-wait': (() => {
    const ev = agy();
    return {
      steps: {
        'user gives an instruction': [ev(prompt('Fix it'))],
        'an approval request the agent answers itself': [ev({ hook_event_name: 'PreToolUse', stepIdx: 2, ...run })],
        'the tool finishes': [ev({ hook_event_name: 'PostToolUse', stepIdx: 2, error: '', ...run })],
      },
    };
  })(),
};
