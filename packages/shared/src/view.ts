// Ciphertext from the server → plaintext for display (browser, CLI). Fields that can't be opened are left empty and marked locked.
import { type ContentKeys, open, type Sealed } from './crypto.js';
import type { Session, StoredSession, StoredTimelineItem, StoredTurn, TimelineItem, Turn } from './session.js';

type Opened = { value?: string; failed: boolean };

async function tryOpen(keys: ContentKeys | null, sealed: Sealed | undefined, aad: string): Promise<Opened> {
  if (sealed === undefined) return { failed: false };
  if (!keys) return { failed: true };
  try {
    return { value: await open(keys, sealed, aad), failed: false };
  } catch {
    return { failed: true };
  }
}

async function openFields<K extends string>(
  keys: ContentKeys | null,
  enc: Partial<Record<K, Sealed>>,
  aad: string,
): Promise<{ values: Partial<Record<K, string>>; locked: boolean }> {
  const values: Partial<Record<K, string>> = {};
  let locked = false;
  await Promise.all(
    (Object.entries(enc) as [K, Sealed][]).map(async ([k, sealed]) => {
      const r = await tryOpen(keys, sealed, aad);
      if (r.failed) locked = true;
      else if (r.value !== undefined) values[k] = r.value;
    }),
  );
  return { values, locked };
}

export async function openSession(keys: ContentKeys | null, s: StoredSession): Promise<Session> {
  const { enc, lastPromptTag: _, ...signals } = s;
  const { values, locked } = await openFields(keys, enc ?? {}, s.key);
  return { ...signals, ...values, ...(locked ? { locked } : {}) };
}

export async function openTurn(keys: ContentKeys | null, t: StoredTurn): Promise<Turn> {
  const [prompt, result] = await Promise.all([tryOpen(keys, t.prompt, t.sessionKey), tryOpen(keys, t.result, t.sessionKey)]);
  return { ...t, prompt: prompt.value, result: result.value };
}

export async function openTimelineItem(keys: ContentKeys | null, sessionKey: string, t: StoredTimelineItem): Promise<TimelineItem> {
  // An item from an earlier session (resumedFrom) is sealed with that session's key
  const { values } = await openFields(keys, t.content ?? {}, t.sessionKey ?? sessionKey);
  const item: TimelineItem = { at: t.at, type: t.type, nativeType: t.nativeType, waitingReason: t.waitingReason };
  if (values.agentType) item.agentType = values.agentType;
  if (values.text) item.text = values.text;
  if (values.tool || t.toolFailed) {
    item.tool = { name: values.tool ?? '🔒', summary: values.toolSummary, ...(t.toolFailed ? { failed: true } : {}) };
  }
  return item;
}
