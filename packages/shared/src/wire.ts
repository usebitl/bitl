// 서버가 받는 레코드 검증 (zod). 내용 필드는 봉인된 형식만 받는다 — 평문이 실수로라도 저장되지 않게.
import { z } from 'zod';
import { SEALED_PATTERN } from './crypto.js';
import { AgentEventType, AgentSource, WaitingReason } from './events.js';
import { EVENT_CONTENT_FIELDS, WIRE_VERSION, type WireRecord } from './prepare.js';

/** 봉인된 값 하나. 표시용 필드는 짧아서(최소화 후 500자) 넉넉히 잡아도 이 정도 */
/** 봉인된 값 한 칸의 최대 길이. 원문 1만 자(한글이면 약 30KB) 를 봉인한 base64url 이 들어가게 */
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
