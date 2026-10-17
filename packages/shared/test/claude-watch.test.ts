import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeTurnMark, watchClaudeTurn } from '../src/node/claude-watch.js';

const line = (r: object) => JSON.stringify(r);
const AT = '2026-10-17T15:20:26.322Z';

describe('claudeTurnMark', () => {
  it('reads an interrupt (as plain text or a text block, with or without "for tool use") and a normal turn end', () => {
    expect(claudeTurnMark(line({ type: 'user', timestamp: AT, message: { content: '[Request interrupted by user]' } }))).toEqual({ mark: 'interrupted', at: AT });
    expect(claudeTurnMark(line({ type: 'user', message: { content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } }))?.mark).toBe('interrupted');
    expect(claudeTurnMark(line({ type: 'system', subtype: 'turn_duration', timestamp: AT }))).toEqual({ mark: 'ended', at: AT });
  });

  it('ignores a subagent\'s own turn, meta lines, the marker quoted inside other text, and everything else', () => {
    expect(claudeTurnMark(line({ type: 'system', subtype: 'turn_duration', isSidechain: true }))).toBeNull();
    expect(claudeTurnMark(line({ type: 'user', isMeta: true, message: { content: '[Request interrupted by user]' } }))).toBeNull();
    expect(claudeTurnMark(line({ type: 'assistant', message: { content: [{ type: 'text', text: 'It writes [Request interrupted by user]' }] } }))).toBeNull();
    expect(claudeTurnMark(line({ type: 'user', message: { content: 'Why does it say [Request interrupted by user]?' } }))).toBeNull();
    expect(claudeTurnMark(line({ type: 'assistant', message: { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' } }))).toBeNull();
    expect(claudeTurnMark('{"type":"user", broken')).toBeNull();
  });
});

describe('watchClaudeTurn', () => {
  const transcript = () => {
    const file = join(mkdtempSync(join(tmpdir(), 'cc-watch-')), 'session.jsonl');
    // What was there before the watcher started must not count (an earlier interrupt)
    writeFileSync(file, `${line({ type: 'user', message: { content: '[Request interrupted by user]' } })}\n${line({ type: 'user', message: { content: 'Explain it at length' } })}\n`);
    return file;
  };

  it('reports an interrupt appended after it started, even when the line arrives in pieces', async () => {
    const file = transcript();
    const watching = watchClaudeTurn(file, { pollMs: 20, maxMs: 2000 });
    const marker = line({ type: 'user', timestamp: AT, message: { content: '[Request interrupted by user]' } });
    setTimeout(() => appendFileSync(file, `${line({ type: 'assistant', message: { content: [] } })}\n${marker.slice(0, 30)}`), 50);
    setTimeout(() => appendFileSync(file, `${marker.slice(30)}\n`), 120);
    expect(await watching).toEqual({ mark: 'interrupted', at: AT });
  });

  it('stops quietly when the turn ends normally, or when time runs out', async () => {
    const file = transcript();
    const watching = watchClaudeTurn(file, { pollMs: 20, maxMs: 2000 });
    setTimeout(() => appendFileSync(file, `${line({ type: 'system', subtype: 'turn_duration' })}\n${line({ type: 'user', message: { content: '[Request interrupted by user]' } })}\n`), 50);
    expect(await watching).toBeNull();
    expect(await watchClaudeTurn(transcript(), { pollMs: 20, maxMs: 100 })).toBeNull();
    expect(await watchClaudeTurn(join(tmpdir(), 'no-such-transcript.jsonl'), { pollMs: 20, maxMs: 100 })).toBeNull();
  });
});
