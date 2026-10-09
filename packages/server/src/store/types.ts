import type { Sealed, StoredSession, StoredTimelineItem, StoredTurn, WireRecord } from '@bitl/shared';

/** 로컬 모드의 유일한 계정. 클라우드 모드에서는 로그인한 계정 id */
export const LOCAL_ACCOUNT = 'local';

/** 구독자에게 알리는 변화. 어느 계정의 변화인지 함께 — SSE 는 자기 계정 것만 보낸다 */
export type StoreChange =
  /** prevStatus: 바뀌기 전 상태 (새 세션이면 없음) — 알림은 "나를 기다림으로 바뀐 순간"에만 보낸다 */
  | { type: 'session'; accountId: string; session: StoredSession; prevStatus?: StoredSession['status'] }
  | { type: 'removed'; accountId: string; key: string };

/** 사용자가 바꿀 수 있는 것. 메모는 브라우저가 암호화해 보낸다 (null 이면 지움) */
export interface SessionEdit {
  pinned?: boolean;
  archived?: boolean;
  note?: Sealed | null;
}

export interface ListOptions {
  includeEnded?: boolean;
  includeArchived?: boolean;
}

/**
 * 세션 저장소. 로컬 모드는 SQLite, 클라우드 모드는 Postgres (같은 구현 + 드라이버만 다름).
 * 모든 조회·변경은 계정 안에서만 일어난다 — accountId 없이 다른 계정의 데이터에 닿는 메서드는 없다.
 * (sweepStale·pruneEvents 는 서버 유지보수용으로 모든 계정에 적용)
 */
export interface SessionStore {
  ingest(accountId: string, rec: WireRecord): Promise<StoredSession>;
  getSession(accountId: string, key: string): Promise<StoredSession | undefined>;
  listSessions(accountId: string, opts?: ListOptions): Promise<StoredSession[]>;
  listTurns(accountId: string, key: string, limit?: number): Promise<StoredTurn[]>;
  listTimeline(accountId: string, key: string, limit?: number): Promise<StoredTimelineItem[]>;
  editSession(accountId: string, key: string, edit: SessionEdit): Promise<StoredSession | undefined>;
  acknowledge(accountId: string, key: string, now?: Date): Promise<StoredSession | undefined>;
  /** 세션과 그 턴·이벤트 기록을 모두 지운다. 지웠으면 true */
  deleteSession(accountId: string, key: string): Promise<boolean>;
  /** 종료된 카드 일괄 삭제 (keys 를 주면 그중에서만). 지운 수 */
  deleteEnded(accountId: string, keys?: string[]): Promise<number>;
  /** 오래 무소식인 running 세션을 stale 로 (모든 계정). 바뀐 수 */
  sweepStale(now?: Date): Promise<number>;
  /** 오래된 원본 이벤트 삭제 (모든 계정, 세션·턴 요약은 남긴다). 지운 수 */
  pruneEvents(olderThan: Date): Promise<number>;
  subscribe(fn: (change: StoreChange) => void): () => void;
  close(): Promise<void>;
  /** 옛 형식 DB 를 옮겨 둔 경로 (SQLite, 있으면 시작 로그에 알린다) */
  readonly backupPath?: string;
}

// ── 드라이버: SQL 방언 차이만 감춘다 ──────────────────────────────

export type Row = Record<string, unknown>;
export type Query = (sql: string, params?: unknown[]) => Promise<{ rows: Row[]; changes: number }>;

export interface Driver {
  readonly dialect: 'sqlite' | 'postgres';
  /** SQL 은 ? 자리표시자로 쓴다 (Postgres 드라이버가 $1… 로 바꾼다) */
  query: Query;
  /**
   * 트랜잭션. lockKey 가 있으면 같은 키의 트랜잭션끼리 순서대로 실행한다 (Postgres: advisory lock).
   * 같은 세션에 이벤트가 동시에 와도 한쪽 변경이 사라지지 않게.
   */
  transaction<T>(fn: (q: Query) => Promise<T>, lockKey?: string): Promise<T>;
  close(): Promise<void>;
}
