import { type ApprovalDecision, type ApprovalRequest, type ContentKeys, openApprovalRequest, signDecision } from '@bitl/shared/client';
import { useCallback, useEffect, useState } from 'react';

/**
 * 원격 승인: PC 의 Claude Code 가 권한을 물으면 여기서 허용·거부한다.
 * 요청 내용은 이 기기의 키로 풀고, 결정은 이 기기의 키로 서명한다 — PC 는 서명을 확인한 결정만 따른다.
 */

/** 서버가 주는 모양 (server/store/approval-store.ts) */
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
  /** 풀지 못하면 없음 (키가 없거나 다른 계정 키) */
  request?: ApprovalRequest;
}

export async function openApproval(keys: ContentKeys | null, a: StoredApproval): Promise<Approval> {
  const request = keys ? await openApprovalRequest(keys, a.id, a.request).catch(() => undefined) : undefined;
  return { id: a.id, sessionKey: a.sessionKey, createdAt: a.createdAt, expiresAt: a.expiresAt, request };
}

/** 서명한 결정을 보낸다. 이미 다른 기기에서 답했거나 PC 가 그만 기다렸으면 그 상태를 알려준다 */
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

/** 원격 승인 켜기·끄기. undefined: 읽는 중, null: 이 서버는 지원하지 않음 */
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
