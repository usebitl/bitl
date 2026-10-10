// For tests: seal raw input and send it like the adapter, then open it like the browser to check
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

/** Raw → wire record (git/transcript extras disabled) */
export async function wire(rec: RawRecord): Promise<WireRecord> {
  const r = await prepareRaw(rec, { keys, enrich: false });
  if (!r) throw new Error(`normalize failed: ${JSON.stringify(rec)}`);
  return r;
}

export const view = (s: StoredSession | undefined) => (s ? openSession(keys, s) : Promise.resolve(undefined));
export const viewTurns = (turns: StoredTurn[]) => Promise.all(turns.map((t) => openTurn(keys, t)));
export const viewTimeline = (key: string, items: StoredTimelineItem[]) => Promise.all(items.map((t) => openTimelineItem(keys, key, t)));
