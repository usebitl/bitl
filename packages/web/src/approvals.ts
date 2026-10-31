import {
  type ApprovalAnswers,
  type ApprovalDecision,
  type ApprovalRequest,
  type ContentKeys,
  openApprovalRequest,
  sealApprovalAnswer,
  signDecision,
} from '@bitl/shared/client';
import { useCallback, useEffect, useState } from 'react';

/**
 * Remote approval: when Claude Code on the PC asks for permission, allow or deny it here.
 * Requests are decrypted and decisions signed with this device's key — the PC only follows decisions whose signature it verifies.
 */

/** Shape returned by the server (server/store/approval-store.ts) */
export interface StoredApproval {
  id: string;
  sessionKey: string;
  request: string;
  status: 'pending' | 'allow' | 'deny' | 'cancelled' | 'expired';
  createdAt: string;
  expiresAt: string;
}

export interface Approval {
  id: string;
  sessionKey: string;
  createdAt: string;
  expiresAt: string;
  /** Absent when it can't be decrypted (no keys, or another account's keys) */
  request?: ApprovalRequest;
}

export async function openApproval(keys: ContentKeys | null, a: StoredApproval): Promise<Approval> {
  const request = keys ? await openApprovalRequest(keys, a.id, a.request).catch(() => undefined) : undefined;
  return { id: a.id, sessionKey: a.sessionKey, createdAt: a.createdAt, expiresAt: a.expiresAt, request };
}

/**
 * Sends a signed decision. Reports the state if another device already answered or the PC stopped waiting.
 * answers: a question's answers — sealed, and covered by the signature
 */
export async function decide(keys: ContentKeys, id: string, decision: ApprovalDecision, answers?: ApprovalAnswers): Promise<'ok' | 'settled' | 'gone'> {
  const answer = answers ? await sealApprovalAnswer(keys, id, answers) : undefined;
  const sig = await signDecision(keys, id, decision, answer);
  const res = await fetch(`/api/approvals/${encodeURIComponent(id)}/decide`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ decision, sig, ...(answer ? { answer } : {}) }),
  });
  if (res.ok) return 'ok';
  return res.status === 409 ? 'settled' : 'gone';
}

/**
 * Questions answered from this device: session key → the statusAt of the question that was answered.
 * The card stays "waiting on a question" until the agent picks the answer up (and for good if it never does), so the question
 * is hidden here until the session moves on or waits on a new question (a new statusAt)
 */
const answered = new Map<string, string>();

export const markAnswered = (sessionKey: string, statusAt: string) => answered.set(sessionKey, statusAt);

export const answeredHere = (s: { key: string; statusAt: string }) => answered.get(s.key) === s.statusAt;

/** Remote approval on/off. undefined: loading, null: not supported by this server */
export function useAwayMode(): { away: boolean | null | undefined; setAway: (on: boolean) => Promise<void> } {
  const [away, setState] = useState<boolean | null | undefined>(undefined);
  useEffect(() => {
    fetch('/api/approvals/mode')
      .then((r) => (r.ok ? (r.json() as Promise<{ away: boolean }>) : null))
      .then((j) => setState(j ? j.away : null))
      .catch(() => setState(null));
  }, []);
  const setAway = useCallback(async (on: boolean) => {
    const res = await fetch('/api/approvals/mode', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ away: on }) });
    if (res.ok) setState(((await res.json()) as { away: boolean }).away);
  }, []);
  return { away, setAway };
}
