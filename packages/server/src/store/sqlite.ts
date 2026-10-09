import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { APPROVAL_SCHEMA } from './approval-store.js';
import { GOAL_SCHEMA } from './goal-store.js';
import { PUSH_SCHEMA } from './push-store.js';
import { SqlStore } from './sql-store.js';
import { type Driver, LOCAL_ACCOUNT, type Query, type Row } from './types.js';

/**
 * 스키마 버전
 *   1: 내용 평문 — 서버는 키가 없어 암호화할 수 없으므로 백업 파일로 옮기고 새로 시작
 *   2: 신호 + 암호문 (Phase 3)
 *   3: 계정별 (account_id), tool_failed 열 — 2 는 그대로 옮긴다 (모두 로컬 계정)
 *   4: 기기·연결·계정 키 테이블 추가 (클라우드 모드용, 더하기만 함)
 *   5: 웹 푸시 구독 테이블 추가 (더하기만 함)
 */
const SCHEMA_VERSION = 10; // v10: goals

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  account_id    TEXT NOT NULL,
  key           TEXT NOT NULL,
  status        TEXT NOT NULL,
  last_event_at TEXT NOT NULL,
  archived      INTEGER NOT NULL DEFAULT 0,
  data          TEXT NOT NULL,
  PRIMARY KEY (account_id, key)
);
CREATE INDEX IF NOT EXISTS sessions_list ON sessions(account_id, last_event_at);
CREATE INDEX IF NOT EXISTS sessions_status ON sessions(status);

CREATE TABLE IF NOT EXISTS turns (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id  TEXT NOT NULL,
  session_key TEXT NOT NULL,
  turn_id     TEXT,
  prompt      TEXT,
  result      TEXT,
  status      TEXT NOT NULL,
  started_at  TEXT NOT NULL,
  ended_at    TEXT,
  tool_count  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS turns_session ON turns(account_id, session_key, started_at);

CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id  TEXT NOT NULL,
  session_key TEXT NOT NULL,
  at          TEXT NOT NULL,
  type        TEXT NOT NULL,
  native_type TEXT NOT NULL,
  tool_failed INTEGER NOT NULL DEFAULT 0,
  data        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_session ON events(account_id, session_key, at);
CREATE INDEX IF NOT EXISTS events_at ON events(at);
${PUSH_SCHEMA}
${APPROVAL_SCHEMA}
${GOAL_SCHEMA}`;

/** 이 저장소 위에 더할 테이블 (클라우드 기능을 SQLite 로 시험할 때). 더하기만 한다 */
export interface SchemaExtension {
  schema: string;
  /** 처음 만든 뒤에 더한 열 */
  addedColumns?: [table: string, column: string, type: string][];
}

/** v2 → v3: 계정 열을 붙여 옮긴다 (SQLite 는 기본 키를 바꿀 수 없어 테이블을 새로 만든다) */
const MIGRATE_2_TO_3 = `
ALTER TABLE sessions RENAME TO sessions_v2;
ALTER TABLE turns RENAME TO turns_v2;
ALTER TABLE events RENAME TO events_v2;
DROP INDEX IF EXISTS sessions_last_event;
DROP INDEX IF EXISTS turns_session;
DROP INDEX IF EXISTS events_session;
${SCHEMA}
INSERT INTO sessions (account_id, key, status, last_event_at, archived, data)
  SELECT '${LOCAL_ACCOUNT}', key, status, last_event_at, archived, data FROM sessions_v2;
INSERT INTO turns (id, account_id, session_key, turn_id, prompt, result, status, started_at, ended_at, tool_count)
  SELECT id, '${LOCAL_ACCOUNT}', session_key, turn_id, prompt, result, status, started_at, ended_at, tool_count FROM turns_v2;
INSERT INTO events (id, account_id, session_key, at, type, native_type, tool_failed, data)
  SELECT id, '${LOCAL_ACCOUNT}', session_key, at, type, native_type, CASE WHEN data LIKE '%"toolFailed":true%' THEN 1 ELSE 0 END, data FROM events_v2;
DROP TABLE sessions_v2;
DROP TABLE turns_v2;
DROP TABLE events_v2;
`;

const isRead = (sql: string) => /^\s*(SELECT|WITH)\b/i.test(sql);
const bind = (params: unknown[]) => params.map((p) => (p === undefined ? null : p)) as SQLInputValue[];

/** node:sqlite 는 동기라 한 번에 하나씩 돈다. 트랜잭션만 차례로 줄 세운다 (중간에 await 가 끼어도 섞이지 않게) */
class SqliteDriver implements Driver {
  readonly dialect = 'sqlite';
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly db: DatabaseSync) {}

  query: Query = async (sql, params = []) => {
    const st = this.db.prepare(sql);
    if (isRead(sql)) return { rows: st.all(...bind(params)) as Row[], changes: 0 };
    return { rows: [], changes: Number(st.run(...bind(params)).changes) };
  };

  transaction<T>(fn: (q: Query) => Promise<T>): Promise<T> {
    const run = async () => {
      this.db.exec('BEGIN');
      try {
        const result = await fn(this.query);
        this.db.exec('COMMIT');
        return result;
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
      }
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => {});
    return p;
  }

  async close() {
    await this.chain;
    this.db.close();
  }
}

function userVersion(db: DatabaseSync): number {
  return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
}

const hasSessions = (db: DatabaseSync) => Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sessions'`).get());

/** 로컬 모드 저장소. path 가 ':memory:' 면 테스트용 메모리 DB */
export function openSqliteStore(path: string, extension?: SchemaExtension): SqlStore {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  let db = new DatabaseSync(path);
  let backupPath: string | undefined;

  if (path !== ':memory:' && hasSessions(db) && userVersion(db) < 2) {
    db.close();
    backupPath = `${path}.v1-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    for (const suffix of ['', '-wal', '-shm']) if (existsSync(path + suffix)) renameSync(path + suffix, backupPath + suffix);
    db = new DatabaseSync(path);
  }

  db.exec('PRAGMA journal_mode = WAL;');
  if (hasSessions(db) && userVersion(db) === 2) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATE_2_TO_3);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  db.exec(SCHEMA);
  if (extension) db.exec(extension.schema);
  // 처음 만든 뒤에 더한 열 (이미 있는 표에 붙인다)
  for (const [table, column, type] of extension?.addedColumns ?? []) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
  return new SqlStore(new SqliteDriver(db), backupPath);
}
