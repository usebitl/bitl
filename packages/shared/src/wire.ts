// Validation of records the server receives (zod). Content fields accept only the sealed format — so plaintext is never stored, even by mistake.
import { z } from 'zod';
import { SEALED_PATTERN } from './crypto.js';
import { AgentEventType, AgentSource, WaitingReason } from './events.js';
import { EVENT_CONTENT_FIELDS, WIRE_VERSION, type WireRecord } from './prepare.js';

/** A single sealed value. Display fields are short (500 chars after minimization), so this is generous enough */
/** Max length of one sealed value. Fits the base64url of 10,000 sealed chars of plaintext (about 30KB for Korean text) */
export const SealedValue = z.string().max(64_000).regex(SEALED_PATTERN);

const id = z.string().min(1).max(200);

export const SignalSchema = z.object({
  source: AgentSource,
  sessionId: id,
  type: AgentEventType,
  nativeType: z.string().min(1).max(100),
  at: z.string().datetime(),
  turnId: id.optional(),
  agentId: id.optional(),
  agentNamed: z.boolean().optional(),
  waitingReason: WaitingReason.optional(),
  toolFailed: z.boolean().optional(),
  requestTag: z.string().max(100).optional(),
  resumedFrom: id.optional(),
});

export const WireRecordSchema = z.object({
  v: z.literal(WIRE_VERSION),
  signal: SignalSchema,
  content: z.partialRecord(z.enum(EVENT_CONTENT_FIELDS), SealedValue),
});

export function parseWireRecord(body: unknown): WireRecord | null {
  const r = WireRecordSchema.safeParse(body);
  return r.success ? (r.data as WireRecord) : null;
}
