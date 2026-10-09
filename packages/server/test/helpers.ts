// 테스트용: 어댑터처럼 원본을 봉인해 보내고, 브라우저처럼 풀어서 확인한다
import {
  deriveKeys,
  openSession,
  openTimelineItem,
  openTurn,
  type RawRecord,
  type StoredSession,
  type StoredTimelineItem,
  type StoredTurn,
  type WireRecord,
} from '@bitl/shared';
import { prepareRaw } from '@bitl/shared/node';

export const keys = await deriveKeys(new Uint8Array(32).fill(7));

/** 원본 → 전송 레코드 (git·트랜스크립트 부가 정보는 끈다) */
export async function wire(rec: RawRecord): Promise<WireRecord> {
  const r = await prepareRaw(rec, { keys, enrich: false });
  if (!r) throw new Error(`정규화 실패: ${JSON.stringify(rec)}`);
  return r;
}

export const view = (s: StoredSession | undefined) => (s ? openSession(keys, s) : Promise.resolve(undefined));
export const viewTurns = (turns: StoredTurn[]) => Promise.all(turns.map((t) => openTurn(keys, t)));
export const viewTimeline = (key: string, items: StoredTimelineItem[]) => Promise.all(items.map((t) => openTimelineItem(keys, key, t)));
