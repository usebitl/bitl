import { describe, expect, it } from 'vitest';
import {
  APPROVAL_ID_PATTERN,
  describeToolRequest,
  newApprovalId,
  openApprovalRequest,
  sealApprovalRequest,
  signDecision,
  verifyDecision,
} from '../src/approval.js';
import { deriveKeys, generateMasterKey, tag } from '../src/crypto.js';

const keysA = await deriveKeys(generateMasterKey());
const keysB = await deriveKeys(generateMasterKey());

describe('승인 요청 봉인', () => {
  it('왕복. 다른 승인 id 로는 열리지 않는다 (서버가 다른 요청 내용을 끼워 넣을 수 없다)', async () => {
    const id = newApprovalId();
    expect(id).toMatch(APPROVAL_ID_PATTERN);
    const req = describeToolRequest('Bash', { command: 'rm -rf dist', description: '빌드 결과 지우기' }, { project: 'api' });
    const sealed = await sealApprovalRequest(keysA, id, req);
    expect(sealed).not.toContain('rm -rf');
    expect(await openApprovalRequest(keysA, id, sealed)).toEqual(req);
    await expect(openApprovalRequest(keysA, newApprovalId(), sealed)).rejects.toThrow();
    await expect(openApprovalRequest(keysB, id, sealed)).rejects.toThrow();
  });

  it('도구별 요약과 자세히', () => {
    expect(describeToolRequest('Bash', { command: 'pnpm test', description: '테스트' })).toMatchObject({
      summary: 'Bash: pnpm test',
      detail: 'pnpm test',
      description: '테스트',
    });
    expect(describeToolRequest('Edit', { file_path: 'src/a.ts', old_string: 'a', new_string: 'b' })).toMatchObject({
      summary: 'Edit: src/a.ts',
      detail: 'src/a.ts\n\n- a\n+ b',
    });
    expect(describeToolRequest('Write', { file_path: 'x.txt', content: 'hello' }).detail).toBe('x.txt\n\nhello');
    expect(describeToolRequest('mcp__db__query', { sql: 'select 1' }).detail).toContain('"sql": "select 1"');
    expect(describeToolRequest('Bash', { command: 'x'.repeat(10_000) }).detail!.length).toBeLessThanOrEqual(4000);
  });
});

describe('결정 서명', () => {
  it('같은 계정 키의 서명만 통과한다', async () => {
    const id = newApprovalId();
    const sig = await signDecision(keysA, id, 'allow');
    expect(await verifyDecision(keysA, id, 'allow', sig)).toBe(true);
    // 다른 키, 다른 결정, 다른 요청, 엉뚱한 값
    expect(await verifyDecision(keysB, id, 'allow', sig)).toBe(false);
    expect(await verifyDecision(keysA, id, 'deny', sig)).toBe(false);
    expect(await verifyDecision(keysA, newApprovalId(), 'allow', sig)).toBe(false);
    expect(await verifyDecision(keysA, id, 'allow', 'A'.repeat(43))).toBe(false);
    expect(await verifyDecision(keysA, id, 'maybe', sig)).toBe(false);
  });

  it('승인 키는 내용 태그(tag) 키와 다르다 — 서버가 본 태그로 승인을 만들 수 없다', async () => {
    const id = newApprovalId();
    const sig = await signDecision(keysA, id, 'allow');
    const t = await tag(keysA, `bitl/approval/v1\n${id}\nallow`);
    expect(sig.startsWith(t)).toBe(false);
  });
});
