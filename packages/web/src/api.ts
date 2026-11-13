import {
  normalizeReport,
  openSession,
  openTurn,
  prepareRecord,
  type ReportEvent,
  type Session,
  type StoredSession,
  type StoredTurn,
  seal,
  sealerFor,
  type Turn,
} from '@bitl/shared/client';
import { t } from './i18n';
import { contentKeys } from './keys';

export interface SessionDetail {
  session: Session;
  /** The newest page of turns (newest first) */
  turns: Turn[];
  /** Older turns are left to load (fetchTurns) */
  hasMore: boolean;
}

const path = (key: string) => `/api/sessions/${encodeURIComponent(key)}`;

/** Content cannot be created without keys (plaintext is never sent to the server) */
async function requireKeys() {
  const keys = await contentKeys();
  if (!keys) throw new Error(t('err.noKeyBrowser'));
  return keys;
}

export async function fetchDetail(key: string): Promise<SessionDetail | null> {
  const res = await fetch(path(key));
  if (!res.ok) return null;
  const raw = (await res.json()) as { session: StoredSession; turns: StoredTurn[]; hasMore?: boolean };
  const keys = await contentKeys();
  const [session, turns] = await Promise.all([openSession(keys, raw.session), Promise.all(raw.turns.map((t) => openTurn(keys, t)))]);
  return { session, turns, hasMore: Boolean(raw.hasMore) };
}

/** The page of turns that started before `before` (newest first) — the detail loads older turns as you scroll */
export async function fetchTurns(key: string, before: string): Promise<{ turns: Turn[]; hasMore: boolean } | null> {
  const res = await fetch(`${path(key)}/turns?before=${encodeURIComponent(before)}`);
  if (!res.ok) return null;
  const raw = (await res.json()) as { turns: StoredTurn[]; hasMore?: boolean };
  const keys = await contentKeys();
  return { turns: await Promise.all(raw.turns.map((t) => openTurn(keys, t))), hasMore: Boolean(raw.hasMore) };
}

export async function postAction(key: string, action: 'ack'): Promise<void> {
  await fetch(`${path(key)}/${action}`, { method: 'POST' });
}

/** Notes are encrypted in this browser before sending ('' clears) */
export async function patchSession(key: string, patch: { note?: string; pinned?: boolean }): Promise<void> {
  const body: { note?: string; pinned?: boolean } = { pinned: patch.pinned };
  if (patch.note !== undefined) body.note = patch.note ? await seal(await requireKeys(), patch.note.slice(0, 2000), key) : '';
  await fetch(path(key), { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

/** Manual task status report (same format as bitl add / bitl report) — normalized and encrypted here, like an adapter */
export async function reportManual(sessionId: string, event: ReportEvent, fields: { title?: string; detail?: string } = {}) {
  const e = normalizeReport('manual', { session_id: sessionId, event, ...fields }, new Date().toISOString());
  if (!e) return;
  const record = await prepareRecord(e, sealerFor(await requireKeys()));
  await fetch('/api/events', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(record) });
}

export const newManualId = () => crypto.randomUUID().slice(0, 8);

/** Bulk-deletes ended cards along with history. With keys, only the ended ones among them (goal-filtered view). Returns the number deleted */
export async function deleteEnded(keys?: string[]): Promise<number> {
  const res = await fetch('/api/sessions/delete-ended', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(keys ? { keys } : {}),
  });
  if (!res.ok) throw new Error(`delete-ended ${res.status}`);
  return ((await res.json()) as { deleted: number }).deleted;
}

/** "Clear": deletes ended cards, sweeps the rest off until their agent acts again; with goals, deletes every goal too */
export async function clearBoard(opts: { goals: boolean }): Promise<void> {
  const res = await fetch('/api/board/clear', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(opts) });
  if (!res.ok) throw new Error(`clear ${res.status}`);
}

/** Deletes a card along with its history (turns, event log) */
export async function deleteSession(key: string): Promise<void> {
  await fetch(path(key), { method: 'DELETE' });
}
