import { type ApprovalDecision, type ApprovalRequest, type ContentKeys, openApprovalRequest, signDecision } from '@bitl/shared/client';
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

/** Sends a signed decision. Reports the state if another device already answered or the PC stopped waiting */
export async function decide(keys: ContentKeys, id: string, decision: ApprovalDecision): Promise<'ok' | 'settled' | 'gone'> {
  const sig = await signDecision(keys, id, decision);
  const res = await fetch(`/api/approvals/${encodeURIComponent(id)}/decide`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ decision, sig }),
  });
  if (res.ok) return 'ok';
  return res.status === 409 ? 'settled' : 'gone';
}

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
