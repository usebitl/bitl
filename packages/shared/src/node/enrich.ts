import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import type { AgentEvent } from '../events.js';
import { carriesContext, type Enrichment } from '../prepare.js';

// Extra info only available on the PC (git branch, project name, Claude Code ai-title).
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

/** The last ai-title record in the Claude Code transcript (auto-generated session title) */
export async function aiTitleFromTranscript(path: string): Promise<string | undefined> {
  try {
    if ((await stat(path)).size > MAX_TRANSCRIPT_BYTES) return undefined;
    const text = await readFile(path, 'utf8');
    let title: string | undefined;
    for (const line of text.split('\n')) {
      if (!line.includes('"ai-title"')) continue;
      try {
        const rec = JSON.parse(line) as { type?: string; aiTitle?: string };
        if (rec.type === 'ai-title' && rec.aiTitle) title = rec.aiTitle;
      } catch {
        // may be the last line still being written
      }
    }
    return title;
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
      aiTitleFromTranscript(e.transcriptPath).then((title) => {
        if (title) extra.aiTitle = title;
      }),
    );
  }
  await Promise.all(tasks.map((t) => t.catch(() => {})));
  return extra;
}
