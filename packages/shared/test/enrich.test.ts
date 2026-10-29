import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { antigravityTitle, codexThreadName, projectName, titleFromTranscript } from '../src/node/enrich.js';

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

  it('long transcripts: reads the tail only, so a title past the size limit still counts', async () => {
    const filler = { type: 'assistant', text: 'x'.repeat(200) };
    const file = transcript({ type: 'custom-title', customTitle: 'old name' }, ...Array(50).fill(filler), { type: 'custom-title', customTitle: 'new name' }, filler);
    expect(await titleFromTranscript(file, 1024)).toBe('new name');
  });

  it('undefined when there is no title or the file is missing', async () => {
    expect(await titleFromTranscript(transcript({ type: 'user' }))).toBeUndefined();
    expect(await titleFromTranscript(join(tmpdir(), 'no-such-transcript.jsonl'))).toBeUndefined();
  });
});

describe('codexThreadName', () => {
  it('the last thread_name line for the thread (auto name, then /rename)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'codex-home-'));
    const lines = [
      { id: 'thread-a', thread_name: 'auto name', updated_at: '2026-10-15T13:00:00Z' },
      { id: 'thread-b', thread_name: 'other thread', updated_at: '2026-10-15T13:01:00Z' },
      { id: 'thread-a', thread_name: 'YO MAN', updated_at: '2026-10-15T13:02:00Z' },
    ];
    writeFileSync(join(home, 'session_index.jsonl'), lines.map((l) => JSON.stringify(l) + '\n').join(''), 'utf8');
    expect(await codexThreadName('thread-a', home)).toBe('YO MAN');
    expect(await codexThreadName('thread-b', home)).toBe('other thread');
    expect(await codexThreadName('thread-c', home)).toBeUndefined();
  });

  it('undefined without a session index', async () => {
    expect(await codexThreadName('thread-a', mkdtempSync(join(tmpdir(), 'codex-empty-')))).toBeUndefined();
  });
});

describe('antigravityTitle', () => {
  it('the title in conversation_summaries (auto title or /rename)', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'agy-')), 'conversation_summaries.db');
    const db = new DatabaseSync(file);
    db.exec("CREATE TABLE conversation_summaries (conversation_id text, title text NOT NULL DEFAULT '', PRIMARY KEY (conversation_id))");
    db.prepare('INSERT INTO conversation_summaries VALUES (?, ?)').run('conv-1', 'HELLO MAN');
    db.prepare('INSERT INTO conversation_summaries VALUES (?, ?)').run('conv-2', '');
    db.close();
    expect(await antigravityTitle('conv-1', file)).toBe('HELLO MAN');
    expect(await antigravityTitle('conv-2', file)).toBeUndefined();
    expect(await antigravityTitle('conv-3', file)).toBeUndefined();
  });

  it('undefined without the DB', async () => {
    expect(await antigravityTitle('conv-1', join(tmpdir(), 'no-such-agy.db'))).toBeUndefined();
  });
});
