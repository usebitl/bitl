import { describe, expect, it } from 'vitest';
import { createInboxKey, deriveKeys, generateMasterKey, INBOX_SEALED_PATTERN, open, sealInbox, unwrapInboxKey } from '../src/crypto.js';
import { openSession } from '../src/view.js';

const keys = await deriveKeys(generateMasterKey());
const other = await deriveKeys(generateMasterKey());

describe('받은편지함 (클라우드 세션)', () => {
  it('서버가 공개키로 잠근 것을 계정 키로 연 개인키로 푼다', async () => {
    const { publicKey, wrappedPrivateKey } = await createInboxKey(keys);
    expect(wrappedPrivateKey.startsWith('v1.')).toBe(true);
    const sealed = await sealInbox(publicKey, '배포 스크립트 고치는 중', 'claude-cloud:t1');
    expect(sealed).toMatch(INBOX_SEALED_PATTERN);
    expect(sealed).not.toContain('배포');
    // 매번 다른 암호문 (일회용 키)
    expect(await sealInbox(publicKey, '배포 스크립트 고치는 중', 'claude-cloud:t1')).not.toBe(sealed);

    const inbox = await unwrapInboxKey(keys, wrappedPrivateKey);
    expect(await open({ ...keys, inbox }, sealed, 'claude-cloud:t1')).toBe('배포 스크립트 고치는 중');
    // 다른 세션으로 옮기면 안 열린다
    await expect(open({ ...keys, inbox }, sealed, 'claude-cloud:t2')).rejects.toThrow();
    // 받은편지함 키가 없으면 안 열린다, 다른 계정 키로는 개인키를 꺼낼 수 없다
    await expect(open(keys, sealed, 'claude-cloud:t1')).rejects.toThrow();
    await expect(unwrapInboxKey(other, wrappedPrivateKey)).rejects.toThrow();
  });

  it('보드: 받은편지함 키가 있으면 클라우드 카드도 풀리고, 없으면 잠김으로', async () => {
    const { publicKey, wrappedPrivateKey } = await createInboxKey(keys);
    const inbox = await unwrapInboxKey(keys, wrappedPrivateKey);
    const s = { key: 'claude-cloud:t1', enc: { title: await sealInbox(publicKey, '맥주 추천', 'claude-cloud:t1') } } as never;
    expect(await openSession({ ...keys, inbox }, s)).toMatchObject({ title: '맥주 추천' });
    expect(await openSession(keys, s)).toMatchObject({ locked: true });
  });
});
