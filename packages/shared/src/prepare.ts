// Adapter → server wire format (v2): signals the server reads (plaintext) + display content (ciphertext).
//
// Step 1, minimize: the raw payload, full tool input (edited code etc.) and tool results (command output etc.) are not sent.
//   All that remains is the tool name, a one-line summary, and the beginning of prompts/responses.
// Step 2, encrypt: the remaining content is sealed per field. The server's state machine runs on signals alone.
//
// Must work without zod — used in the adapter bundle and the browser. Server-side validation is in wire.ts.

import type { Sealed, Sealer } from './crypto.js';
import type { AgentEvent } from './events.js';
import type { AgentEventType, AgentSource, WaitingReason } from './kinds.js';
import { oneLine } from './normalize.js';
import { sessionKey } from './session.js';

export const WIRE_VERSION = 2;

/** Display content carried by events (all sent as ciphertext) */
export const EVENT_CONTENT_FIELDS = [
  'title', // prompt: card title (first line)
  'text', // prompt: instruction / turn_end: response / error·waiting·progress: description — beginning only
  'request', // status report (MCP): the request this response answered
  'activity', // "[Explore] Bash: pnpm test"
  'tool',
  'toolSummary',
  'agentType',
  'cwd',
  'project',
  'gitBranch',
  'aiTitle',
  'model',
] as const;
export type EventContentField = (typeof EVENT_CONTENT_FIELDS)[number];
export type EventContent<T = string> = Partial<Record<EventContentField, T>>;

/** Signals the server reads. Only what the state machine needs */
export interface Signal {
  source: AgentSource;
  sessionId: string;
  type: AgentEventType;
  /** Original event name (e.g. "PreToolUse", "report:done") */
  nativeType: string;
  /** UTC ISO 8601 */
  at: string;
  turnId?: string;
  /** Event from a subagent (random id) */
  agentId?: string;
  /** Whether the subagent has a type — if empty it's Claude Code internal work and isn't counted */
  agentNamed?: boolean;
  waitingReason?: WaitingReason;
  toolFailed?: boolean;
  /** Tag (HMAC) of the instruction/request content. Compares whether it's the same request without knowing the value */
  requestTag?: string;
  /**
   * The session this one continues (its sessionId): Claude Code's `--resume` may start a new session with the old
   * conversation copied in. Found on the PC from the transcripts (node/resume.ts); the server hides the old card
   */
  resumedFrom?: string;
}

export interface WireRecord {
  v: typeof WIRE_VERSION;
  signal: Signal;
  content: EventContent<Sealed>;
}

/** Extra info only available on the PC (node/enrich.ts) */
export type Enrichment = Pick<EventContent, 'project' | 'gitBranch' | 'aiTitle'> & {
  /** Not content: goes into the signal (the server links the cards) */
  resumedFrom?: string;
};

/** Length limit (chars) for question/response text. Generous so the detail view shows the full response — 2026-10-04 500 → 10,000 */
export const TEXT_LIMIT = 10_000;
export const TITLE_LIMIT = 80;

const clip = (s: string, max = TEXT_LIMIT): string => {
  const t = s.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** Events that also carry the work location (cwd/project/branch). Not sent with every tool event */
export const carriesContext = (e: Pick<AgentEvent, 'type' | 'nativeType'>): boolean =>
  e.type === 'session_start' || e.type === 'prompt' || e.type === 'turn_end' || e.nativeType === 'CwdChanged';

export function activityOf(e: Pick<AgentEvent, 'tool' | 'agentId' | 'agentType'>): string | undefined {
  if (!e.tool) return undefined;
  const base = e.tool.summary ? `${e.tool.name}: ${e.tool.summary}` : e.tool.name;
  return e.agentId && e.agentType ? `[${e.agentType}] ${base}` : base;
}

/** Normalized event → signal + plaintext content (before sealing). Minimization is complete here */
export function splitEvent(e: AgentEvent, enrichment: Enrichment = {}): { signal: Signal; content: EventContent; tagSource?: string } {
  const { resumedFrom, ...extra } = enrichment;
  const newCwd = e.nativeType === 'CwdChanged' && typeof e.raw.new_cwd === 'string' ? e.raw.new_cwd : undefined;
  const signal: Signal = {
    source: e.source,
    sessionId: e.sessionId,
    type: e.type,
    nativeType: e.nativeType,
    at: e.at,
    turnId: e.turnId,
    agentId: e.agentId,
    agentNamed: e.agentId || e.agentType !== undefined ? Boolean(e.agentType) : undefined,
    waitingReason: e.waitingReason,
    toolFailed: e.tool?.failed || undefined,
    resumedFrom,
  };
  const content: EventContent = {
    title: e.type === 'prompt' && e.text ? oneLine(e.text, TITLE_LIMIT) : undefined,
    text: e.text ? clip(e.text) : undefined,
    request: e.request ? clip(e.request) : undefined,
    activity: activityOf(e),
    tool: e.tool?.name,
    toolSummary: e.tool?.summary,
    agentType: e.agentType || undefined,
    cwd: newCwd ?? (carriesContext(e) ? e.cwd : undefined),
    model: e.model,
    ...extra,
  };
  const tagSource = e.type === 'prompt' ? (e.request ?? e.text) : e.request;
  return { signal: dropUndefined(signal), content: dropUndefined(content), tagSource };
}

function dropUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== '')) as T;
}

/** Record to send. Content is sealed with the session key as AAD */
export async function prepareRecord(e: AgentEvent, sealer: Sealer, extra: Enrichment = {}): Promise<WireRecord> {
  const { signal, content, tagSource } = splitEvent(e, extra);
  const aad = sessionKey(e.source, e.sessionId);
  const sealed: EventContent<Sealed> = {};
  await Promise.all(
    (Object.entries(content) as [EventContentField, string][]).map(async ([k, v]) => {
      sealed[k] = await sealer.seal(v, aad);
    }),
  );
  if (tagSource) signal.requestTag = await sealer.tag(tagSource);
  return { v: WIRE_VERSION, signal, content: sealed };
}
