import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { AgentEvent } from '../events.js';
import { carriesContext, type Enrichment } from '../prepare.js';
import { bitlHome } from './keys.js';
import { resumedFromFor } from './resume.js';

// Extra info only available on the PC (git branch, project name, session title — the user's /rename or the agent's auto title).
// The server can't see files on the customer's PC, so the adapter attaches it before sending.

const BRANCH_TTL_MS = 60_000;
const MAX_TRANSCRIPT_BYTES = 20 * 1024 * 1024;
const branchCache = new Map<string, { at: number; branch?: string }>();

export function gitBranch(cwd: string): Promise<string | undefined> {
  const hit = branchCache.get(cwd);
  if (hit && Date.now() - hit.at < BRANCH_TTL_MS) return Promise.resolve(hit.branch);
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, 'branch', '--show-current'], { timeout: 2000, windowsHide: true }, (err, stdout) => {
      const branch = err ? undefined : stdout.trim() || undefined;
      branchCache.set(cwd, { at: Date.now(), branch });
      resolve(branch);
    });
  });
}

/**
 * Session title from the Claude Code transcript: the last custom-title record (the user's /rename) wins,
 * otherwise the last ai-title record (auto-generated)
 */
export async function titleFromTranscript(path: string): Promise<string | undefined> {
  try {
    if ((await stat(path)).size > MAX_TRANSCRIPT_BYTES) return undefined;
    const text = await readFile(path, 'utf8');
    let aiTitle: string | undefined;
    let customTitle: string | undefined;
    for (const line of text.split('\n')) {
      if (!line.includes('"ai-title"') && !line.includes('"custom-title"')) continue;
      try {
        const rec = JSON.parse(line) as { type?: string; aiTitle?: string; customTitle?: string };
        if (rec.type === 'ai-title' && rec.aiTitle) aiTitle = rec.aiTitle;
        if (rec.type === 'custom-title' && rec.customTitle?.trim()) customTitle = rec.customTitle.trim();
      } catch {
        // may be the last line still being written
      }
    }
    return customTitle ?? aiTitle;
  } catch {
    return undefined;
  }
}

/**
 * Codex thread name: the last line for this thread in $CODEX_HOME/session_index.jsonl (default ~/.codex).
 * Codex appends a line both for its auto name and for /rename (codex-cli 0.162, not a public spec)
 */
export async function codexThreadName(threadId: string, codexHome = process.env.CODEX_HOME?.trim() || join(homedir(), '.codex')): Promise<string | undefined> {
  try {
    const file = join(codexHome, 'session_index.jsonl');
    if ((await stat(file)).size > MAX_TRANSCRIPT_BYTES) return undefined;
    let name: string | undefined;
    for (const line of (await readFile(file, 'utf8')).split('\n')) {
      if (!line.includes(threadId)) continue;
      try {
        const rec = JSON.parse(line) as { id?: string; thread_name?: string };
        if (rec.id === threadId && rec.thread_name?.trim()) name = rec.thread_name.trim();
      } catch {
        // may be the last line still being written
      }
    }
    return name;
  } catch {
    return undefined;
  }
}

/** node:sqlite without the "SQLite is an experimental feature" warning — hooks must never write to the agent's screen */
async function importSqliteQuietly(): Promise<typeof import('node:sqlite')> {
  const emitWarning = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    if (String(typeof warning === 'string' ? warning : warning.message).startsWith('SQLite is an experimental feature')) return;
    (emitWarning as (...a: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    return await import('node:sqlite');
  } finally {
    process.emitWarning = emitWarning;
  }
}

/**
 * Antigravity CLI conversation title: conversation_summaries.title in ~/.gemini/antigravity-cli/conversation_summaries.db.
 * Holds agy's auto title, replaced by /rename (agy 1.3.2, not a public spec). Needs node:sqlite (Node 22.5+) — otherwise undefined
 */
export async function antigravityTitle(
  conversationId: string,
  dbPath = join(homedir(), '.gemini', 'antigravity-cli', 'conversation_summaries.db'),
): Promise<string | undefined> {
  try {
    await stat(dbPath);
    const { DatabaseSync } = await importSqliteQuietly();
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = db.prepare('SELECT title FROM conversation_summaries WHERE conversation_id = ?').get(conversationId) as { title?: unknown } | undefined;
      return typeof row?.title === 'string' && row.title.trim() ? row.title.trim() : undefined;
    } finally {
      db.close();
    }
  } catch {
    return undefined; // no DB, no node:sqlite, or the DB is locked/changed
  }
}

/** Top-level folder of the git repository containing cwd. undefined if not a git repository */
export function gitRoot(cwd: string): Promise<string | undefined> {
  const hit = rootCache.get(cwd);
  if (hit && Date.now() - hit.at < BRANCH_TTL_MS) return Promise.resolve(hit.root);
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { timeout: 2000, windowsHide: true }, (err, stdout) => {
      const root = err ? undefined : stdout.trim() || undefined;
      rootCache.set(cwd, { at: Date.now(), root });
      resolve(root);
    });
  });
}
const rootCache = new Map<string, { at: number; root?: string }>();

/** Project name: the git repository's top-level folder name (same project even after cd into a subfolder), otherwise the cwd folder name */
export async function projectName(cwd: string): Promise<string> {
  const root = await gitRoot(cwd);
  return basename((root ?? cwd).replace(/[\\/]+$/, ''));
}

/** Extra info to attach to an event. Runs git only for events where the location may change. Failed items are dropped */
export async function enrichEvent(e: AgentEvent, home = bitlHome()): Promise<Enrichment> {
  const extra: Enrichment = {};
  const newCwd = e.nativeType === 'CwdChanged' && typeof e.raw.new_cwd === 'string' ? e.raw.new_cwd : undefined;
  const cwd = newCwd ?? e.cwd;
  const tasks: Promise<void>[] = [];
  if (cwd && carriesContext(e)) {
    tasks.push(
      Promise.all([gitBranch(cwd), projectName(cwd)]).then(([branch, project]) => {
        if (branch) extra.gitBranch = branch;
        extra.project = project;
      }),
    );
  }
  // Session title (the user's /rename or the agent's auto title) — read at prompt and turn end only, so tool calls stay light
  if (e.type === 'prompt' || e.type === 'turn_end') {
    const title =
      e.source === 'claude-code' && e.transcriptPath
        ? titleFromTranscript(e.transcriptPath)
        : e.source === 'codex'
          ? codexThreadName(e.sessionId)
          : e.source === 'antigravity'
            ? antigravityTitle(e.sessionId)
            : undefined;
    if (title)
      tasks.push(
        title.then((t) => {
          if (t) extra.aiTitle = t;
        }),
      );
  }
  // Claude Code `--resume` that started a new session: the earlier session's id (scanned once per resumed session, then cached)
  tasks.push(
    resumedFromFor(e, home).then((from) => {
      if (from) extra.resumedFrom = from;
    }),
  );
  await Promise.all(tasks.map((t) => t.catch(() => {})));
  return extra;
}
