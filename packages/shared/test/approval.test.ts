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

describe('sealing approval requests', () => {
  it('round-trips; does not open under another approval id (the server cannot swap in other request content)', async () => {
    const id = newApprovalId();
    expect(id).toMatch(APPROVAL_ID_PATTERN);
    const req = describeToolRequest('Bash', { command: 'rm -rf dist', description: '빌드 결과 지우기' }, { project: 'api' });
    const sealed = await sealApprovalRequest(keysA, id, req);
    expect(sealed).not.toContain('rm -rf');
    expect(await openApprovalRequest(keysA, id, sealed)).toEqual(req);
    await expect(openApprovalRequest(keysA, newApprovalId(), sealed)).rejects.toThrow();
    await expect(openApprovalRequest(keysB, id, sealed)).rejects.toThrow();
  });

  it('per-tool summary and detail', () => {
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

describe('decision signatures', () => {
  it('only a signature from the same account key passes', async () => {
    const id = newApprovalId();
    const sig = await signDecision(keysA, id, 'allow');
    expect(await verifyDecision(keysA, id, 'allow', sig)).toBe(true);
    // other key, other decision, other request, garbage value
    expect(await verifyDecision(keysB, id, 'allow', sig)).toBe(false);
    expect(await verifyDecision(keysA, id, 'deny', sig)).toBe(false);
    expect(await verifyDecision(keysA, newApprovalId(), 'allow', sig)).toBe(false);
    expect(await verifyDecision(keysA, id, 'allow', 'A'.repeat(43))).toBe(false);
    expect(await verifyDecision(keysA, id, 'maybe', sig)).toBe(false);
  });

  it('the approval key differs from the content tag key — the server cannot forge approvals from tags it has seen', async () => {
    const id = newApprovalId();
    const sig = await signDecision(keysA, id, 'allow');
    const t = await tag(keysA, `bitl/approval/v1\n${id}\nallow`);
    expect(sig.startsWith(t)).toBe(false);
  });
});
