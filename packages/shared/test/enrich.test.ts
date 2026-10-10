import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { projectName } from '../src/node/enrich.js';

describe('projectName', () => {
  it('repo top-level folder name, even from a subfolder of a git repo', async () => {
    // Use a temp repo so the test works regardless of the folder name the repo was cloned into
    const repo = mkdtempSync(join(tmpdir(), 'proj-'));
    execFileSync('git', ['init', '-q', repo]);
    const sub = join(repo, 'packages', 'web');
    mkdirSync(sub, { recursive: true });
    expect(await projectName(sub)).toBe(basename(repo));
    expect(await projectName(repo)).toBe(basename(repo));
  });

  it('cwd folder name when not in a git repo', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'not-a-repo-'));
    expect(await projectName(dir)).toMatch(/^not-a-repo-/);
  });
});
