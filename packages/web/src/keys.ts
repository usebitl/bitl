import { type ContentKeys, keysFromBase64Url } from '@bitl/shared/client';

/**
 * This browser's content keys. The server never knows them — card contents are decrypted here.
 * Received once via a `bitl pair` link (#key=…) and stored in IndexedDB as a non-extractable CryptoKey.
 * The part after # is never sent to the server, and it is removed from the URL as soon as it is read.
 */

const DB_NAME = 'bitl';
const STORE = 'keys';
const RECORD = 'content';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function withStore<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = fn(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

async function init(): Promise<ContentKeys | null> {
  const m = /(?:^#|&)key=([\w-]+)/.exec(window.location.hash);
  if (m?.[1]) {
    history.replaceState(null, '', window.location.pathname + window.location.search);
    const keys = await keysFromBase64Url(m[1]);
    // if it can't be stored (private mode, etc.), use it only while this page is open
    await withStore('readwrite', (s) => s.put(keys, RECORD)).catch(() => {});
    return keys;
  }
  return withStore<ContentKeys | undefined>('readonly', (s) => s.get(RECORD))
    .then((k) => k ?? null)
    .catch(() => null);
}

let current: Promise<ContentKeys | null> | undefined;

// Opening a pairing link in an already-open tab only changes the part after #, so the page doesn't reload — reload once to pick up the key
window.addEventListener('hashchange', () => {
  if (/(?:^#|&)key=/.test(window.location.hash)) window.location.reload();
});

/** Read once per page (the link's key if opened via a pairing link) */
export const contentKeys = (): Promise<ContentKeys | null> => (current ??= init());

const listeners = new Set<(keys: ContentKeys) => void>();

export function onKeysChanged(fn: (keys: ContentKeys) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Stores the account keys received via device pairing and notifies the UI */
export async function saveContentKeys(keys: ContentKeys): Promise<void> {
  await withStore('readwrite', (s) => s.put(keys, RECORD)).catch(() => {});
  current = Promise.resolve(keys);
  for (const fn of listeners) fn(keys);
}
