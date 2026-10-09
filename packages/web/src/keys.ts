import { type ContentKeys, keysFromBase64Url } from '@bitl/shared/client';

/**
 * 이 브라우저의 내용 키. 서버는 키를 모른다 — 카드 내용은 여기서 푼다.
 * 처음 한 번 `bitl pair` 링크(#key=…)로 받아 IndexedDB 에 추출 불가능한 CryptoKey 로 보관한다.
 * 주소의 # 뒤는 서버로 전송되지 않고, 받은 즉시 주소에서 지운다.
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
    // 저장하지 못하면(사생활 보호 모드 등) 이 페이지를 연 동안만 쓴다
    await withStore('readwrite', (s) => s.put(keys, RECORD)).catch(() => {});
    return keys;
  }
  return withStore<ContentKeys | undefined>('readonly', (s) => s.get(RECORD))
    .then((k) => k ?? null)
    .catch(() => null);
}

let current: Promise<ContentKeys | null> | undefined;

// 이미 열린 탭에서 연결 링크를 열면 # 뒤만 바뀌어 페이지가 다시 읽히지 않는다 — 한 번 새로 읽어 키를 받는다
window.addEventListener('hashchange', () => {
  if (/(?:^#|&)key=/.test(window.location.hash)) window.location.reload();
});

/** 페이지당 한 번 읽는다 (연결 링크로 열었으면 그 키) */
export const contentKeys = (): Promise<ContentKeys | null> => (current ??= init());

const listeners = new Set<(keys: ContentKeys) => void>();

export function onKeysChanged(fn: (keys: ContentKeys) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 기기 연결로 받은 계정 키를 저장하고 화면에 알린다 */
export async function saveContentKeys(keys: ContentKeys): Promise<void> {
  await withStore('readwrite', (s) => s.put(keys, RECORD)).catch(() => {});
  current = Promise.resolve(keys);
  for (const fn of listeners) fn(keys);
}
