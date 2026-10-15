import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import type { AgentEvent } from '../events.js';
import { carriesContext, type Enrichment } from '../prepare.js';

// Extra info only available on the PC (git branch, project name, Claude Code session title: /rename or ai-title).
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
export async function enrichEvent(e: AgentEvent): Promise<Enrichment> {
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
  if (e.source === 'claude-code' && e.transcriptPath && (e.type === 'prompt' || e.type === 'turn_end')) {
    tasks.push(
      titleFromTranscript(e.transcriptPath).then((title) => {
        if (title) extra.aiTitle = title;
      }),
    );
  }
  await Promise.all(tasks.map((t) => t.catch(() => {})));
  return extra;
}
