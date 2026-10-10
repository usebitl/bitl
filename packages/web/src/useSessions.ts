import { type ContentKeys, openSession, type Session, type StoredSession } from '@bitl/shared/client';
import { useEffect, useState } from 'react';
import { type Approval, openApproval, type StoredApproval } from './approvals';
import { type Goal, openGoal, type StoredGoal } from './goals';
import { contentKeys, onKeysChanged } from './keys';

export type Connection = 'connecting' | 'live' | 'offline';

/** This browser's keys. undefined: loading, null: none (card contents show as 🔒) */
export function useContentKeys(): ContentKeys | null | undefined {
  const [keys, setKeys] = useState<ContentKeys | null | undefined>(undefined);
  useEffect(() => {
    contentKeys().then(setKeys, () => setKeys(null));
    return onKeysChanged(setKeys); // show card contents as soon as keys arrive via device pairing
  }, []);
  return keys;
}

/**
 * Keeps the session list live via SSE. If the EventSource drops, the browser reconnects automatically.
 * The server sends ciphertext — decrypted here into display sessions. Decryption is async, so events are processed in arrival order.
 */
export function useSessions(keys: ContentKeys | null | undefined) {
  const [sessions, setSessions] = useState<Map<string, Session>>(new Map());
  const [connection, setConnection] = useState<Connection>('connecting');
  /** Remote approval: pending requests (id → request) */
  const [approvals, setApprovals] = useState<Map<string, Approval>>(new Map());
  /** Goals: unfinished ones (id → goal) */
  const [goals, setGoals] = useState<Map<string, Goal>>(new Map());

  useEffect(() => {
    if (keys === undefined) return; // connect after keys are loaded
    let chain = Promise.resolve();
    const inOrder = (fn: () => Promise<void>) => {
      chain = chain.then(fn).catch(() => {});
    };
    const openAll = (list: StoredSession[]) => Promise.all(list.map((s) => openSession(keys, s)));

    // fetch the list once first so the board isn't empty where SSE is slow or blocked (proxies, webviews)
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

/** Current time, ticking periodically to refresh relative time displays */
export function useNow(intervalMs = 15_000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
