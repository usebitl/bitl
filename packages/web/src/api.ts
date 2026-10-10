import {
  normalizeReport,
  openSession,
  openTimelineItem,
  openTurn,
  prepareRecord,
  type ReportEvent,
  type Session,
  type StoredSession,
  type StoredTimelineItem,
  type StoredTurn,
  seal,
  sealerFor,
  type TimelineItem,
  type Turn,
} from '@bitl/shared/client';
import { t } from './i18n';
import { contentKeys } from './keys';

export interface SessionDetail {
  session: Session;
  turns: Turn[];
  timeline: TimelineItem[];
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
  const raw = (await res.json()) as { session: StoredSession; turns: StoredTurn[]; timeline: StoredTimelineItem[] };
  const keys = await contentKeys();
  const [session, turns, timeline] = await Promise.all([
    openSession(keys, raw.session),
    Promise.all(raw.turns.map((t) => openTurn(keys, t))),
    Promise.all(raw.timeline.map((t) => openTimelineItem(keys, key, t))),
  ]);
  return { session, turns, timeline };
}

export async function postAction(key: string, action: 'ack' | 'archive' | 'unarchive'): Promise<void> {
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

/** Deletes a card along with its history (turns, timeline) */
export async function deleteSession(key: string): Promise<void> {
  await fetch(path(key), { method: 'DELETE' });
}
