import { type ContentKeys, openSession, type Session, type StoredSession } from '@bitl/shared/client';
import { useEffect, useState } from 'react';
import { type Approval, openApproval, type StoredApproval } from './approvals';
import { type Goal, openGoal, type StoredGoal } from './goals';
import { contentKeys, onKeysChanged } from './keys';

export type Connection = 'connecting' | 'live' | 'offline';

/** 이 브라우저의 키. undefined: 읽는 중, null: 없음 (카드 내용이 🔒 로 보인다) */
export function useContentKeys(): ContentKeys | null | undefined {
  const [keys, setKeys] = useState<ContentKeys | null | undefined>(undefined);
  useEffect(() => {
    contentKeys().then(setKeys, () => setKeys(null));
    return onKeysChanged(setKeys); // 기기 연결로 키를 받으면 바로 카드 내용이 보이게
  }, []);
  return keys;
}

/**
 * SSE 로 세션 목록을 실시간 유지한다. EventSource 가 끊기면 브라우저가 자동 재연결한다.
 * 서버가 보내는 것은 암호문 — 여기서 풀어서 화면용 세션으로 바꾼다. 복호화는 비동기라 도착 순서대로 처리한다.
 */
export function useSessions(keys: ContentKeys | null | undefined) {
  const [sessions, setSessions] = useState<Map<string, Session>>(new Map());
  const [connection, setConnection] = useState<Connection>('connecting');
  /** 원격 승인: 기다리는 요청 (id → 요청) */
  const [approvals, setApprovals] = useState<Map<string, Approval>>(new Map());
  /** 목표: 마치지 않은 것 (id → 목표) */
  const [goals, setGoals] = useState<Map<string, Goal>>(new Map());

  useEffect(() => {
    if (keys === undefined) return; // 키를 읽은 뒤에 연결
    let chain = Promise.resolve();
    const inOrder = (fn: () => Promise<void>) => {
      chain = chain.then(fn).catch(() => {});
    };
    const openAll = (list: StoredSession[]) => Promise.all(list.map((s) => openSession(keys, s)));

    // SSE 가 늦거나 막히는 환경(프록시, 웹뷰)에서도 보드가 비지 않도록 목록을 먼저 한 번 읽는다
    let gotSnapshot = false;
    fetch('/api/sessions?ended=1')
      .then((r) => (r.ok ? (r.json() as Promise<StoredSession[]>) : null))
      .then((list) => {
        if (list)
          inOrder(async () => {
            const opened = await openAll(list);
            if (!gotSnapshot) setSessions(new Map(opened.map((s) => [s.key, s])));
          });
      })
      .catch(() => {});

    const es = new EventSource('/api/stream');
    es.addEventListener('open', () => setConnection('live'));
    es.addEventListener('error', () => setConnection('offline'));
    es.addEventListener('snapshot', (ev) => {
      gotSnapshot = true;
      const list = JSON.parse((ev as MessageEvent).data) as StoredSession[];
      inOrder(async () => {
        const opened = await openAll(list);
        setSessions(new Map(opened.map((s) => [s.key, s])));
      });
      setConnection('live');
    });
    es.addEventListener('session', (ev) => {
      const stored = JSON.parse((ev as MessageEvent).data) as StoredSession;
      inOrder(async () => {
        const s = await openSession(keys, stored);
        setSessions((prev) => new Map(prev).set(s.key, s));
      });
    });
    es.addEventListener('approvals', (ev) => {
      const list = JSON.parse((ev as MessageEvent).data) as StoredApproval[];
      inOrder(async () => {
        const opened = await Promise.all(list.map((a) => openApproval(keys, a)));
        setApprovals(new Map(opened.map((a) => [a.id, a])));
      });
    });
    es.addEventListener('approval', (ev) => {
      const stored = JSON.parse((ev as MessageEvent).data) as StoredApproval;
      inOrder(async () => {
        if (stored.status === 'pending') {
          const a = await openApproval(keys, stored);
          setApprovals((prev) => new Map(prev).set(a.id, a));
        } else
          setApprovals((prev) => {
            const next = new Map(prev);
            next.delete(stored.id);
            return next;
          });
      });
    });
    es.addEventListener('goals', (ev) => {
      const list = JSON.parse((ev as MessageEvent).data) as StoredGoal[];
      inOrder(async () => {
        const opened = await Promise.all(list.map((g) => openGoal(keys, g)));
        setGoals(new Map(opened.map((g) => [g.id, g])));
      });
    });
    es.addEventListener('goal', (ev) => {
      const stored = JSON.parse((ev as MessageEvent).data) as StoredGoal;
      inOrder(async () => {
        const g = await openGoal(keys, stored);
        setGoals((prev) => {
          const next = new Map(prev);
          if (g.closedAt) next.delete(g.id);
          else next.set(g.id, g);
          return next;
        });
      });
    });
    es.addEventListener('goal-removed', (ev) => {
      const { id } = JSON.parse((ev as MessageEvent).data) as { id: string };
      inOrder(async () =>
        setGoals((prev) => {
          const next = new Map(prev);
          next.delete(id);
          return next;
        }),
      );
    });
    es.addEventListener('removed', (ev) => {
      const { key } = JSON.parse((ev as MessageEvent).data) as { key: string };
      inOrder(async () =>
        setSessions((prev) => {
          const next = new Map(prev);
          next.delete(key);
          return next;
        }),
      );
    });
    return () => es.close();
  }, [keys]);

  const goalList = [...goals.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return { sessions: [...sessions.values()], approvals: [...approvals.values()], goals: goalList, connection };
}

/** 상대 시간 표시를 주기적으로 갱신하기 위한 현재 시각 */
export function useNow(intervalMs = 15_000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
