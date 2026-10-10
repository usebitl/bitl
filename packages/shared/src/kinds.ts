// Event kind value lists — kept separate so they can be used without zod (adapter bundle, browser).
// The zod schemas in events.ts are built from these lists.

// claude-cloud: Claude running in the cloud (Cowork/web/mobile) — reports via the remote MCP connector; the server locks it with the inbox key on receipt
export const AGENT_SOURCES = ['claude-code', 'codex', 'antigravity', 'claude-desktop', 'claude-cloud', 'manual'] as const;
export type AgentSource = (typeof AGENT_SOURCES)[number];

/**
 * Common event kinds. Adapters normalize agent-specific events into one of these.
 * Board state transitions are decided from this value alone.
 */
export const AGENT_EVENT_TYPES = [
  'session_start',
  'session_end',
  'prompt', // the user gave a task → running
  'tool_start',
  'tool_end',
  'waiting', // waiting for user input/approval → waiting_for_you
  'turn_end', // agent turn ended → needs_review
  'subagent_start',
  'subagent_end',
  'error', // turn failed due to an API error etc.
  'progress', // MCP self-report / manual progress
  'notice', // informational event with no effect on status (compact, cwd change, etc.)
] as const;
export type AgentEventType = (typeof AGENT_EVENT_TYPES)[number];

export const WAITING_REASONS = [
  'permission', // permission to run a tool
  'question', // the agent asks a multiple-choice question (AskUserQuestion)
  'plan', // plan approval (ExitPlanMode)
  'elicitation', // input request from an MCP server
  'input', // other input requests
  'idle', // waiting for the next instruction after a turn ends ("needs review" on the board)
  'other',
] as const;
export type WaitingReason = (typeof WAITING_REASONS)[number];
