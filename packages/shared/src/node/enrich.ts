import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import type { AgentEvent } from '../events.js';
import { carriesContext, type Enrichment } from '../prepare.js';

// PC 에서만 알 수 있는 부가 정보 (git 브랜치, 프로젝트 이름, Claude Code ai-title).
// 서버는 고객 PC 의 파일을 볼 수 없으므로 어댑터가 보내기 전에 붙인다.

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

/** Claude Code 트랜스크립트의 마지막 ai-title 레코드 (자동 생성된 세션 제목) */
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
        // 쓰는 중인 마지막 줄일 수 있음
      }
    }
    return title;
  } catch {
    return undefined;
  }
}

/** cwd 가 속한 git 저장소 최상위 폴더. git 저장소가 아니면 undefined */
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

/** 프로젝트 이름: git 저장소 최상위 폴더 이름 (하위 폴더로 cd 해도 같은 프로젝트), 아니면 cwd 폴더 이름 */
export async function projectName(cwd: string): Promise<string> {
  const root = await gitRoot(cwd);
  return basename((root ?? cwd).replace(/[\\/]+$/, ''));
}

/** 이벤트에 붙일 부가 정보. 위치가 바뀔 수 있는 이벤트에서만 git 을 실행한다. 실패한 항목은 뺀다 */
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
