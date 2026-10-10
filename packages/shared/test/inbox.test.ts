import { describe, expect, it } from 'vitest';
import { createInboxKey, deriveKeys, generateMasterKey, INBOX_SEALED_PATTERN, open, sealInbox, unwrapInboxKey } from '../src/crypto.js';
import { openSession } from '../src/view.js';

const keys = await deriveKeys(generateMasterKey());
const other = await deriveKeys(generateMasterKey());

describe('inbox (cloud sessions)', () => {
  it('what the server seals with the public key opens with the private key unwrapped by the account key', async () => {
    const { publicKey, wrappedPrivateKey } = await createInboxKey(keys);
    expect(wrappedPrivateKey.startsWith('v1.')).toBe(true);
    const sealed = await sealInbox(publicKey, '배포 스크립트 고치는 중', 'claude-cloud:t1');
    expect(sealed).toMatch(INBOX_SEALED_PATTERN);
    expect(sealed).not.toContain('배포');
    // different ciphertext every time (ephemeral key)
    expect(await sealInbox(publicKey, '배포 스크립트 고치는 중', 'claude-cloud:t1')).not.toBe(sealed);

    const inbox = await unwrapInboxKey(keys, wrappedPrivateKey);
    expect(await open({ ...keys, inbox }, sealed, 'claude-cloud:t1')).toBe('배포 스크립트 고치는 중');
    // does not open when moved to another session
    await expect(open({ ...keys, inbox }, sealed, 'claude-cloud:t2')).rejects.toThrow();
    // does not open without the inbox key; another account key cannot unwrap the private key
    await expect(open(keys, sealed, 'claude-cloud:t1')).rejects.toThrow();
    await expect(unwrapInboxKey(other, wrappedPrivateKey)).rejects.toThrow();
  });

  it('board: cloud cards open with the inbox key, and show as locked without it', async () => {
    const { publicKey, wrappedPrivateKey } = await createInboxKey(keys);
    const inbox = await unwrapInboxKey(keys, wrappedPrivateKey);
    const s = { key: 'claude-cloud:t1', enc: { title: await sealInbox(publicKey, '맥주 추천', 'claude-cloud:t1') } } as never;
    expect(await openSession({ ...keys, inbox }, s)).toMatchObject({ title: '맥주 추천' });
    expect(await openSession(keys, s)).toMatchObject({ locked: true });
  });
});
