import { z } from 'zod';
import { AGENT_EVENT_TYPES, AGENT_SOURCES, WAITING_REASONS } from './kinds.js';

/** Kind of agent that sent the event */
export const AgentSource = z.enum(AGENT_SOURCES);
export type AgentSource = z.infer<typeof AgentSource>;
/** Common event kinds (see kinds.ts) */
export const AgentEventType = z.enum(AGENT_EVENT_TYPES);
export type AgentEventType = z.infer<typeof AgentEventType>;
export const WaitingReason = z.enum(WAITING_REASONS);
export type WaitingReason = z.infer<typeof WaitingReason>;

/**
 * A normalized event. Used only inside the adapter (PC) — prepare.ts splits it into signals (plaintext) and content (ciphertext) for the server.
 * raw is the original payload and never leaves the adapter.
 */
export const AgentEvent = z.object({
  source: AgentSource,
  sessionId: z.string().min(1),
  type: AgentEventType,
  /** Original event name (e.g. "PreToolUse", "agent-turn-complete") */
  nativeType: z.string(),
  at: z.string().datetime(),
  cwd: z.string().optional(),
  turnId: z.string().optional(),
  /** The subagent's id if the event came from a subagent */
  agentId: z.string().optional(),
  agentType: z.string().optional(),
  tool: z
    .object({
      name: z.string(),
      useId: z.string().optional(),
      /** One-line summary shown on the board (e.g. "src/app.ts", "pnpm test") */
      summary: z.string().optional(),
      failed: z.boolean().optional(),
    })
    .optional(),
  /** prompt: user prompt / turn_end: last response / error: error message */
  text: z.string().optional(),
  /** Status reports (MCP/manual) only: summary of the user request this response answered. A new value is recorded as a new turn */
  request: z.string().optional(),
  waitingReason: WaitingReason.optional(),
  transcriptPath: z.string().optional(),
  model: z.string().optional(),
  /** Original payload (for normalization rules; never sent to the server) */
  raw: z.record(z.string(), z.unknown()),
});
export type AgentEvent = z.infer<typeof AgentEvent>;
