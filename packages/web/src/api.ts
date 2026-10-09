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

/** 키가 없으면 내용을 만들 수 없다 (서버에 평문을 보내지 않는다) */
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

/** 메모는 이 브라우저에서 암호화해 보낸다 ('' 는 지움) */
export async function patchSession(key: string, patch: { note?: string; pinned?: boolean }): Promise<void> {
  const body: { note?: string; pinned?: boolean } = { pinned: patch.pinned };
  if (patch.note !== undefined) body.note = patch.note ? await seal(await requireKeys(), patch.note.slice(0, 2000), key) : '';
  await fetch(path(key), { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

/** 수동 작업 상태 보고 (bitl add / bitl report 와 같은 형식) — 어댑터처럼 여기서 정규화·암호화한다 */
export async function reportManual(sessionId: string, event: ReportEvent, fields: { title?: string; detail?: string } = {}) {
  const e = normalizeReport('manual', { session_id: sessionId, event, ...fields }, new Date().toISOString());
  if (!e) return;
  const record = await prepareRecord(e, sealerFor(await requireKeys()));
  await fetch('/api/events', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(record) });
}

export const newManualId = () => crypto.randomUUID().slice(0, 8);

/** 종료된 카드를 기록째 일괄 삭제. keys 를 주면 그중 종료된 것만 (목표로 거른 화면). 지운 수 */
export async function deleteEnded(keys?: string[]): Promise<number> {
  const res = await fetch('/api/sessions/delete-ended', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(keys ? { keys } : {}),
  });
  if (!res.ok) throw new Error(`delete-ended ${res.status}`);
  return ((await res.json()) as { deleted: number }).deleted;
}

/** 카드를 기록(턴·타임라인)째 지운다 */
export async function deleteSession(key: string): Promise<void> {
  await fetch(path(key), { method: 'DELETE' });
}
