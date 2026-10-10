import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AgentEvent, type AgentSource, normalizeAntigravity, normalizeCodexNotify, normalizeHook } from '../src/index.js';

/** One line written by dump-hook.mjs */
export type DumpRecord = { source: string; event: string | null; receivedAt: string; payload: Record<string, unknown> };

export function loadDumpRecords(dir: string): { where: string; rec: DumpRecord }[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .flatMap((f) =>
      readFileSync(join(dir, f), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line, i) => ({ where: `${f}:${i + 1}`, rec: JSON.parse(line) as DumpRecord })),
    );
}

/** Checks that every dump record in the directory normalizes and passes the schema. */
export function describeDumpRecords(title: string, dir: string): void {
  describe(title, () => {
    const records = loadDumpRecords(dir);
    if (records.length === 0) {
      it.skip(`no dumps: ${dir}`, () => {});
      return;
    }
    it.each(records)('$where', ({ rec }) => {
      if (rec.source === 'antigravity') {
        // The event name is outside the payload (--event). Model calls within a turn etc. are dropped on purpose (null)
        const e = normalizeAntigravity({ ...rec.payload, hook_event_name: rec.event }, rec.receivedAt);
        if (e) expect(() => AgentEvent.parse(e)).not.toThrow();
        return;
      }
      const e =
        rec.source === 'codex-notify'
          ? normalizeCodexNotify(rec.payload, rec.receivedAt)
          : normalizeHook(rec.source as AgentSource, rec.payload, rec.receivedAt);
      expect(e, `normalize failed: ${rec.event}`).not.toBeNull();
      expect(() => AgentEvent.parse(e)).not.toThrow();
    });
  });
}
