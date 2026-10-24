// For tests: seal raw input and send it like the adapter, then open it like the browser to check
import { deriveKeys, openSession, openTurn, type RawRecord, type StoredSession, type StoredTurn, type WireRecord } from '@bitl/shared';
import { prepareRaw } from '@bitl/shared/node';
import type { SqlStore } from '../src/store/sql-store.js';
import type { SessionStore } from '../src/store/types.js';

export const keys = await deriveKeys(new Uint8Array(32).fill(7));

/** Raw → wire record (git/transcript extras disabled) */
export async function wire(rec: RawRecord): Promise<WireRecord> {
  const r = await prepareRaw(rec, { keys, enrich: false });
  if (!r) throw new Error(`normalize failed: ${JSON.stringify(rec)}`);
  return r;
}

export const view = (s: StoredSession | undefined) => (s ? openSession(keys, s) : Promise.resolve(undefined));
export const viewTurns = (turns: StoredTurn[]) => Promise.all(turns.map((t) => openTurn(keys, t)));

/** A session's raw event log, newest first — no API reads it (it's kept a few days for debugging), so tests read the table */
export async function eventLog(store: SessionStore, accountId: string, key: string) {
  const { rows } = await (store as SqlStore).db.query(
    'SELECT native_type, tool_failed, data FROM events WHERE account_id = ? AND session_key = ? ORDER BY at DESC, id DESC',
    [accountId, key],
  );
  return rows.map((r) => ({ nativeType: r.native_type as string, toolFailed: Number(r.tool_failed) === 1, data: JSON.parse(r.data as string) as object }));
}
