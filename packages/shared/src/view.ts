// Ciphertext from the server → plaintext for display (browser, CLI). Fields that can't be opened are left empty and marked locked.
import { type ContentKeys, open, type Sealed } from './crypto.js';
import type { Session, StoredSession, StoredTurn, Turn } from './session.js';

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
