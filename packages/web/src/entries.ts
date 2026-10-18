import { type ContentKeys, open, seal, toBase64Url } from '@bitl/shared/client';
import { contentKeys } from './keys';

/**
 * Entries — the short notes a person leaves along the way: what they solved, learned, or where they were in the flow.
 * They outlive cards (clearing or deleting a card leaves them), so each keeps where it was written (card title, project…).
 * Everything but the time and the card it belongs to is sealed as one blob (AAD = entry:<id>) — including which goal.
 */

export const ENTRY_KINDS = ['solved', 'learned', 'flow'] as const;
export type EntryKind = (typeof ENTRY_KINDS)[number];
/** Max length of one entry — a line or two, so it gets written */
export const ENTRY_LIMIT = 280;

/** Where the entry was written, kept so it still makes sense after the card is gone */
export interface EntryWhere {
  title?: string;
  project?: string;
  branch?: string;
  source?: string;
}

export interface EntryContent {
  kind?: EntryKind;
  text: string;
  goalId?: string;
  where?: EntryWhere;
  /** Moved over from the card's old note */
  fromNote?: boolean;
}

/** As returned by the server */
export interface StoredEntry {
  id: string;
  sessionKey?: string;
  data: string;
  createdAt: string;
  updatedAt: string;
}

export interface Entry extends EntryContent {
  id: string;
  sessionKey?: string;
  createdAt: string;
  updatedAt: string;
  /** Cannot be opened with this browser's keys */
  locked?: boolean;
}

const aad = (id: string) => `entry:${id}`;
const json = (body: unknown) => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

export async function openEntry(keys: ContentKeys | null, e: StoredEntry): Promise<Entry> {
  const base = { id: e.id, sessionKey: e.sessionKey, createdAt: e.createdAt, updatedAt: e.updatedAt };
  if (!keys) return { ...base, text: '', locked: true };
  try {
    const c = JSON.parse(await open(keys, e.data, aad(e.id))) as Partial<EntryContent>;
    const kind = ENTRY_KINDS.includes(c.kind as EntryKind) ? (c.kind as EntryKind) : undefined;
    return { ...base, kind, text: String(c.text ?? ''), goalId: c.goalId, where: c.where, fromNote: c.fromNote };
  } catch {
    return { ...base, text: '', locked: true };
  }
}

async function requireKeys(): Promise<ContentKeys> {
  const keys = await contentKeys();
  if (!keys) throw new Error('no keys');
  return keys;
}

const sealContent = (keys: ContentKeys, id: string, c: EntryContent) =>
  seal(keys, JSON.stringify({ ...c, text: c.text.trim().slice(0, ENTRY_LIMIT) }), aad(id));

export async function fetchEntries(query: { session?: string; since?: string; before?: string; limit?: number } = {}): Promise<Entry[]> {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined) params.set(k, String(v));
  const res = await fetch(`/api/entries?${params}`);
  if (!res.ok) throw new Error(`entries ${res.status}`);
  const keys = await contentKeys();
  return Promise.all(((await res.json()) as StoredEntry[]).map((e) => openEntry(keys, e)));
}

export async function writeEntry(c: EntryContent, sessionKey?: string): Promise<void> {
  const keys = await requireKeys();
  const id = toBase64Url(crypto.getRandomValues(new Uint8Array(12)));
  const res = await fetch('/api/entries', { method: 'POST', ...json({ id, data: await sealContent(keys, id, c), ...(sessionKey ? { sessionKey } : {}) }) });
  if (!res.ok) throw new Error(`entry write ${res.status}`);
}

export async function rewriteEntry(entry: Entry, change: Partial<EntryContent>): Promise<void> {
  const keys = await requireKeys();
  const { kind, text, goalId, where, fromNote } = { ...entry, ...change };
  const res = await fetch(`/api/entries/${entry.id}`, { method: 'PUT', ...json({ data: await sealContent(keys, entry.id, { kind, text, goalId, where, fromNote }) }) });
  if (!res.ok) throw new Error(`entry rewrite ${res.status}`);
}

export async function deleteEntry(id: string): Promise<void> {
  await fetch(`/api/entries/${id}`, { method: 'DELETE' });
}

/** Live changes from the stream (useSessions) to whatever list shows entries */
export type EntryEvent = { type: 'entry'; entry: Entry } | { type: 'entry-removed'; id: string };
const EVENT = 'bitl:entry';
export const announceEntry = (e: EntryEvent) => window.dispatchEvent(new CustomEvent<EntryEvent>(EVENT, { detail: e }));
export function onEntry(fn: (e: EntryEvent) => void): () => void {
  const listener = (ev: Event) => fn((ev as CustomEvent<EntryEvent>).detail);
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}
