import { openSqliteStore, type SqlStore } from '../src/store/index.js';

/**
 * 저장소를 쓰는 테스트를 어느 DB 에서 돌릴지. 기본은 SQLite (로컬 모드).
 * 다른 저장소를 더하려면 vitest setupFiles 에서 이 배열에 넣는다 — 같은 테스트가 그 DB 에서도 돈다.
 */
export const DATABASES: [name: string, open: () => Promise<SqlStore>][] = [['sqlite', async () => openSqliteStore(':memory:')]];

/** 저장소 계약 테스트에만 더할 DB (테스트마다 비우는 실제 서버 등) */
export const CONTRACT_DATABASES: [name: string, open: () => Promise<SqlStore>][] = [];
