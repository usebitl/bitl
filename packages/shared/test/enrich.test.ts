import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { projectName, titleFromTranscript } from '../src/node/enrich.js';

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

describe('titleFromTranscript', () => {
  const transcript = (...records: object[]) => {
    const file = join(mkdtempSync(join(tmpdir(), 'transcript-')), 'session.jsonl');
    writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    return file;
  };

  it('the last ai-title when the session was never renamed', async () => {
    const file = transcript({ type: 'ai-title', aiTitle: 'first' }, { type: 'user' }, { type: 'ai-title', aiTitle: 'second' });
    expect(await titleFromTranscript(file)).toBe('second');
  });

  it('a /rename (custom-title) wins over ai-titles written before or after it', async () => {
    const file = transcript(
      { type: 'ai-title', aiTitle: 'auto' },
      { type: 'custom-title', customTitle: 'old name' },
      { type: 'custom-title', customTitle: 'hello world' },
      { type: 'ai-title', aiTitle: 'auto again' },
    );
    expect(await titleFromTranscript(file)).toBe('hello world');
  });

  it('undefined when there is no title or the file is missing', async () => {
    expect(await titleFromTranscript(transcript({ type: 'user' }))).toBeUndefined();
    expect(await titleFromTranscript(join(tmpdir(), 'no-such-transcript.jsonl'))).toBeUndefined();
  });
});
