import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AgentEvent, type AgentSource, normalizeAntigravity, normalizeCodexNotify, normalizeHook } from '../src/index.js';

/** dump-hook.mjs 가 남기는 한 줄 */
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

/** 디렉터리의 모든 덤프 레코드가 정규화되고 스키마를 통과하는지 검증한다. */
export function describeDumpRecords(title: string, dir: string): void {
  describe(title, () => {
    const records = loadDumpRecords(dir);
    if (records.length === 0) {
      it.skip(`덤프 없음: ${dir}`, () => {});
      return;
    }
    it.each(records)('$where', ({ rec }) => {
      if (rec.source === 'antigravity') {
        // 이벤트 이름은 페이로드 밖(--event)에 있다. 턴 안의 모델 호출 등은 일부러 버린다(null)
        const e = normalizeAntigravity({ ...rec.payload, hook_event_name: rec.event }, rec.receivedAt);
        if (e) expect(() => AgentEvent.parse(e)).not.toThrow();
        return;
      }
      const e =
        rec.source === 'codex-notify'
          ? normalizeCodexNotify(rec.payload, rec.receivedAt)
          : normalizeHook(rec.source as AgentSource, rec.payload, rec.receivedAt);
      expect(e, `정규화 실패: ${rec.event}`).not.toBeNull();
      expect(() => AgentEvent.parse(e)).not.toThrow();
    });
  });
}
