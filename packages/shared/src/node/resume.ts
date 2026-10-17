import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { AgentEvent } from '../events.js';

/**
 * `claude --resume` may start a NEW session (new id) with the old conversation copied into its transcript — the copied
 * messages keep their ids. Find the session it continues: the transcript in the same project folder that holds the
 * newest copied message, preferring the one where that message is its last (a fork of the same session holds it too).
 *
 * Only resumed sessions are looked at (SessionStart source "resume"), the answer is cached in BITL_HOME, and later
 * events read the cache — so ordinary sessions and tool calls never scan transcripts. Plaintext never leaves the PC:
 * only the earlier session's id is sent.
 */

const MAX_TRANSCRIPT_BYTES = 20 * 1024 * 1024;
const MAX_CANDIDATES = 200;
const CACHE_FILE = 'resume-links.json';
const CACHE_LIMIT = 200;
const UUID = /"uuid":"([0-9a-f-]{36})"/g;

/** Message ids in a transcript, in order */
const messageIds = (text: string): string[] => [...text.matchAll(UUID)].map((m) => m[1]!);

/**
 * The session this transcript continues; null if it continues none (a plain session, or one resumed under its own id);
 * undefined if it can't tell yet (no messages written so far)
 */
export async function findResumedFrom(transcriptPath: string): Promise<string | null | undefined> {
  const own = basename(transcriptPath, '.jsonl');
  if ((await stat(transcriptPath)).size > MAX_TRANSCRIPT_BYTES) return null;
  const ids = messageIds(await readFile(transcriptPath, 'utf8'));
  if (ids.length === 0) return undefined;

  const dir = dirname(transcriptPath);
  const candidates: { id: string; ids: Set<string>; last?: string; mtime: number }[] = [];
  const names = (await readdir(dir)).filter((n) => n.endsWith('.jsonl') && basename(n, '.jsonl') !== own);
  for (const name of names.slice(0, MAX_CANDIDATES)) {
    try {
      const file = join(dir, name);
      const info = await stat(file);
      if (info.size > MAX_TRANSCRIPT_BYTES) continue;
      const list = messageIds(await readFile(file, 'utf8'));
      if (list.length) candidates.push({ id: basename(name, '.jsonl'), ids: new Set(list), last: list.at(-1), mtime: info.mtimeMs });
    } catch {
      // removed or unreadable meanwhile
    }
  }
  // A transcript that holds our last message and goes on past it copied US (it continues this session) — never our predecessor
  const ourLast = ids.at(-1)!;
  const earlier = candidates.filter((c) => !(c.ids.has(ourLast) && c.last !== ourLast));
  // Newest message also found elsewhere = where the copy stopped (messages after it are this session's own)
  for (let i = ids.length - 1; i >= 0; i--) {
    const id = ids[i]!;
    const holders = earlier.filter((c) => c.ids.has(id));
    if (!holders.length) continue;
    const ended = holders.find((c) => c.last === id);
    return (ended ?? holders.sort((a, b) => b.mtime - a.mtime)[0]!).id;
  }
  return null;
}

/** pending: resumed, but the transcript had no messages yet — looked up again at the next prompt */
type Cache = Record<string, { from?: string; pending?: true; at: string }>;

async function readCache(home: string): Promise<Cache> {
  try {
    return JSON.parse(await readFile(join(home, CACHE_FILE), 'utf8')) as Cache;
  } catch {
    return {};
  }
}

/**
 * For Claude Code events: the earlier session id, if this session continues one. Looks it up once at a resumed
 * SessionStart (if the transcript has no messages yet, again at the next prompt), then answers from the cache.
 */
export async function resumedFromFor(e: AgentEvent, home: string): Promise<string | undefined> {
  if (e.source !== 'claude-code' || !e.transcriptPath) return undefined;
  const cache = await readCache(home);
  const hit = cache[e.sessionId];
  if (hit && !hit.pending) return hit.from;
  const resumed = e.nativeType === 'SessionStart' && e.raw.source === 'resume';
  if (!resumed && !(hit?.pending && e.type === 'prompt')) return undefined;
  const found = await findResumedFrom(e.transcriptPath).catch(() => null);
  // Cache the answer (and "not one") so later events don't scan again
  cache[e.sessionId] = found === undefined ? { pending: true, at: e.at } : { ...(found ? { from: found } : {}), at: e.at };
  const kept = Object.entries(cache)
    .sort((a, b) => b[1].at.localeCompare(a[1].at))
    .slice(0, CACHE_LIMIT);
  await writeFile(join(home, CACHE_FILE), JSON.stringify(Object.fromEntries(kept))).catch(() => {});
  return found ?? undefined;
}
