import {
  sessionKey,
  type StoredSession,
  type StoredTimelineItem,
  type StoredTurn,
  type WireRecord,
} from '@bitl/shared';
import { acknowledge, applyEvent, markStale, type TurnOp } from '../state.js';
import type { Driver, ListOptions, Query, Row, SessionEdit, SessionStore, StoreChange } from './types.js';

/**
 * SQLite·Postgres 공용 저장소. SQL 은 두 DB 가 모두 이해하는 부분만 쓴다 (ON CONFLICT … excluded, CAST, LIMIT).
 * 시각은 UTC ISO 8601 문자열 그대로 저장한다 — 문자열 순서 = 시간 순서 (state.ts 와 같은 규칙).
 */
export class SqlStore implements SessionStore {
  private listeners = new Set<(change: StoreChange) => void>();

  constructor(
    /** 같은 DB 를 쓰는 다른 저장소(CloudStore)와 공유한다 */
    readonly db: Driver,
    readonly backupPath?: string,
  ) {}

  close() {
    return this.db.close();
  }

  subscribe(fn: (change: StoreChange) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(change: StoreChange) {
    for (const fn of this.listeners) fn(change);
  }

  /** 계정·세션 키를 섞이지 않게 묶는다 (Postgres 문자열에는 NUL 을 쓸 수 없다) */
  private static lockKey = (accountId: string, key: string) => JSON.stringify([accountId, key]);

  private static async read(q: Query, accountId: string, key: string): Promise<StoredSession | undefined> {
    const { rows } = await q('SELECT data FROM sessions WHERE account_id = ? AND key = ?', [accountId, key]);
    return rows[0] ? (JSON.parse(rows[0].data as string) as StoredSession) : undefined;
  }

  private static async save(q: Query, accountId: string, s: StoredSession) {
    await q(
      `INSERT INTO sessions (account_id, key, status, last_event_at, archived, data) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (account_id, key) DO UPDATE SET status = excluded.status, last_event_at = excluded.last_event_at,
         archived = excluded.archived, data = excluded.data`,
      [accountId, s.key, s.status, s.lastEventAt, s.archived ? 1 : 0, JSON.stringify(s)],
    );
  }

  private static async applyTurn(q: Query, accountId: string, key: string, op: TurnOp) {
    const turnId = op.turnId ?? null;
    // turnId 가 같은 열린 턴, 없으면 가장 최근 열린 턴
    const { rows } = await q(
      `SELECT id FROM turns WHERE account_id = ? AND session_key = ? AND status = 'running'
       AND (CAST(? AS TEXT) IS NULL OR turn_id = ? OR turn_id IS NULL) ORDER BY id DESC LIMIT 1`,
      [accountId, key, turnId, turnId],
    );
    const open = rows[0]?.id;

    if (op.op === 'start') {
      // 이전 턴이 turn_end 없이 끝났으면 닫는다
      await q(`UPDATE turns SET status = 'done', ended_at = ? WHERE account_id = ? AND session_key = ? AND status = 'running'`, [op.at, accountId, key]);
      await q(`INSERT INTO turns (account_id, session_key, turn_id, prompt, status, started_at, tool_count) VALUES (?, ?, ?, ?, 'running', ?, 0)`, [
        accountId,
        key,
        turnId,
        op.prompt ?? null,
        op.at,
      ]);
    } else if (op.op === 'end' && open !== undefined) {
      await q('UPDATE turns SET status = ?, result = ?, ended_at = ? WHERE id = ?', [op.status, op.result ?? null, op.at, open]);
    } else if (op.op === 'tool' && open !== undefined) {
      await q('UPDATE turns SET tool_count = tool_count + 1 WHERE id = ?', [open]);
    }
  }

  /** 세션 하나를 읽고-바꾸고-쓰기. 같은 세션의 변경끼리는 순서대로 (lockKey) */
  private async update(
    accountId: string,
    key: string,
    fn: (cur: StoredSession) => StoredSession | null,
  ): Promise<StoredSession | undefined> {
    let changed = false;
    let prevStatus: StoredSession['status'] | undefined;
    const result = await this.db.transaction(async (q) => {
      const cur = await SqlStore.read(q, accountId, key);
      if (!cur) return undefined;
      prevStatus = cur.status;
      const next = fn(cur);
      if (!next || JSON.stringify(next) === JSON.stringify(cur)) return cur;
      await SqlStore.save(q, accountId, next);
      changed = true;
      return next;
    }, SqlStore.lockKey(accountId, key));
    if (changed && result) this.emit({ type: 'session', accountId, session: result, prevStatus });
    return result;
  }

  async ingest(accountId: string, { signal: e, content }: WireRecord): Promise<StoredSession> {
    const key = sessionKey(e.source, e.sessionId);
    let prevStatus: StoredSession['status'] | undefined;
    const session = await this.db.transaction(async (q) => {
      const prev = await SqlStore.read(q, accountId, key);
      prevStatus = prev?.status;
      const { session, turns } = applyEvent(prev, e, content);
      await SqlStore.save(q, accountId, session);
      for (const op of turns) await SqlStore.applyTurn(q, accountId, key, op);
      await q('INSERT INTO events (account_id, session_key, at, type, native_type, tool_failed, data) VALUES (?, ?, ?, ?, ?, ?, ?)', [
        accountId,
        key,
        e.at,
        e.type,
        e.nativeType,
        e.toolFailed ? 1 : 0,
        JSON.stringify({ signal: e, content }),
      ]);
      return session;
    }, SqlStore.lockKey(accountId, key));
    this.emit({ type: 'session', accountId, session, prevStatus });
    return session;
  }

  getSession(accountId: string, key: string) {
    return SqlStore.read(this.db.query, accountId, key);
  }

  async listSessions(accountId: string, opts: ListOptions = {}): Promise<StoredSession[]> {
    const where = ['account_id = ?'];
    if (!opts.includeEnded) where.push(`status != 'ended'`);
    if (!opts.includeArchived) where.push('archived = 0');
    const { rows } = await this.db.query(`SELECT data FROM sessions WHERE ${where.join(' AND ')} ORDER BY last_event_at DESC`, [accountId]);
    return rows.map((r) => JSON.parse(r.data as string) as StoredSession);
  }

  async listTurns(accountId: string, key: string, limit = 50): Promise<StoredTurn[]> {
    const { rows } = await this.db.query(
      `SELECT session_key, turn_id, prompt, result, status, started_at, ended_at, tool_count
       FROM turns WHERE account_id = ? AND session_key = ? ORDER BY started_at DESC, id DESC LIMIT ?`,
      [accountId, key, limit],
    );
    const opt = (v: unknown) => (v === null || v === undefined ? undefined : (v as string));
    return rows.map((r: Row) => ({
      sessionKey: r.session_key as string,
      turnId: opt(r.turn_id),
      prompt: opt(r.prompt),
      result: opt(r.result),
      status: r.status as StoredTurn['status'],
      startedAt: r.started_at as string,
      endedAt: opt(r.ended_at),
      toolCount: Number(r.tool_count),
    }));
  }

  /**
   * 세션 상세 타임라인 (최신순). 참고용(notice) 이벤트는 빼고,
   * 도구 완료(tool_end)는 시작과 중복이라 실패한 것만 남긴다.
   */
  async listTimeline(accountId: string, key: string, limit = 200): Promise<StoredTimelineItem[]> {
    const { rows } = await this.db.query(
      `SELECT data FROM events WHERE account_id = ? AND session_key = ? AND type != 'notice'
       AND NOT (type = 'tool_end' AND tool_failed = 0)
       ORDER BY at DESC, id DESC LIMIT ?`,
      [accountId, key, limit],
    );
    return rows.map((r) => {
      const { signal: e, content: c } = JSON.parse(r.data as string) as Pick<WireRecord, 'signal' | 'content'>;
      const content: StoredTimelineItem['content'] = {};
      for (const f of ['tool', 'toolSummary', 'agentType', 'text'] as const) if (c[f]) content[f] = c[f];
      return { at: e.at, type: e.type, nativeType: e.nativeType, waitingReason: e.waitingReason, toolFailed: e.toolFailed, content };
    });
  }

  editSession(accountId: string, key: string, edit: SessionEdit) {
    return this.update(accountId, key, (cur) => {
      const next: StoredSession = { ...cur, enc: { ...cur.enc } };
      if (edit.pinned !== undefined) next.pinned = edit.pinned;
      if (edit.archived !== undefined) next.archived = edit.archived;
      if (edit.note === null) delete next.enc.note;
      else if (edit.note !== undefined) next.enc.note = edit.note;
      return next;
    });
  }

  acknowledge(accountId: string, key: string, now = new Date()) {
    return this.update(accountId, key, (cur) => acknowledge(cur, now));
  }

  async deleteSession(accountId: string, key: string): Promise<boolean> {
    const deleted = await this.db.transaction(async (q) => {
      const { changes } = await q('DELETE FROM sessions WHERE account_id = ? AND key = ?', [accountId, key]);
      await q('DELETE FROM turns WHERE account_id = ? AND session_key = ?', [accountId, key]);
      await q('DELETE FROM events WHERE account_id = ? AND session_key = ?', [accountId, key]);
      return changes > 0;
    }, SqlStore.lockKey(accountId, key));
    if (deleted) this.emit({ type: 'removed', accountId, key });
    return deleted;
  }

  /**
   * 종료된 카드를 기록째 지운다 (보드의 "종료 → 모두 지우기"). keys 를 주면 그중 종료된 것만 (목표로 거른 화면).
   * 목록을 읽은 뒤 새 이벤트로 다시 살아난 카드는 지우지 않도록, 지울 때 잠근 채로 상태를 다시 본다. 지운 수를 돌려준다
   */
  async deleteEnded(accountId: string, keys?: string[]): Promise<number> {
    const { rows } = await this.db.query(`SELECT key FROM sessions WHERE account_id = ? AND status = 'ended' AND archived = 0`, [accountId]);
    const only = keys ? new Set(keys) : null;
    let n = 0;
    for (const r of rows) {
      const key = r.key as string;
      if (only && !only.has(key)) continue;
      const deleted = await this.db.transaction(async (q) => {
        const { changes } = await q(`DELETE FROM sessions WHERE account_id = ? AND key = ? AND status = 'ended'`, [accountId, key]);
        if (changes === 0) return false;
        await q('DELETE FROM turns WHERE account_id = ? AND session_key = ?', [accountId, key]);
        await q('DELETE FROM events WHERE account_id = ? AND session_key = ?', [accountId, key]);
        return true;
      }, SqlStore.lockKey(accountId, key));
      if (deleted) {
        n++;
        this.emit({ type: 'removed', accountId, key });
      }
    }
    return n;
  }

  async sweepStale(now = new Date()): Promise<number> {
    const { rows } = await this.db.query(`SELECT account_id, key FROM sessions WHERE status = 'running'`);
    let n = 0;
    for (const r of rows) {
      // 목록을 읽은 뒤 새 이벤트가 왔을 수 있으니 잠근 채로 다시 판단한다
      await this.update(r.account_id as string, r.key as string, (cur) => {
        const next = markStale(cur, now);
        if (next) n++;
        return next;
      });
    }
    return n;
  }

  async pruneEvents(olderThan: Date): Promise<number> {
    return this.db.transaction(async (q) => (await q('DELETE FROM events WHERE at < ?', [olderThan.toISOString()])).changes);
  }
}
