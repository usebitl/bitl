import { describe, expect, it } from 'vitest';
import {
  deriveKeys,
  fromBase64Url,
  generateMasterKey,
  open,
  SEALED_PATTERN,
  seal,
  sealedWith,
  tag,
  toBase64Url,
} from '../src/crypto.js';

const keysA = await deriveKeys(generateMasterKey());
const keysB = await deriveKeys(generateMasterKey());

describe('seal / open', () => {
  it('round-trips (Korean, emoji, newlines, empty string)', async () => {
    for (const text of ['로그인 버그 고쳐줘', 'emoji 🔒\n두 줄', '', ' 끝에 공백 ', 'x'.repeat(1000)]) {
      const sealed = await seal(keysA, text, 'claude-code:s1');
      expect(sealed).toMatch(SEALED_PATTERN);
      expect(await open(keysA, sealed, 'claude-code:s1')).toBe(text);
    }
  });

  it('ciphertext does not reveal plaintext, and the same value encrypts differently each time', async () => {
    const a = await seal(keysA, 'pnpm test', 's');
    const b = await seal(keysA, 'pnpm test', 's');
    expect(a).not.toBe(b);
    expect(a).not.toContain('pnpm');
  });

  it('length is revealed only in 32-byte steps', async () => {
    const len = async (t: string) => (await seal(keysA, t, 's')).length;
    expect(await len('a')).toBe(await len('a'.repeat(31)));
    expect(await len('a'.repeat(32))).toBeGreaterThan(await len('a'.repeat(31)));
  });

  it('does not open with another key, another session (AAD), or tampered value', async () => {
    const sealed = await seal(keysA, '비밀', 'claude-code:s1');
    await expect(open(keysB, sealed, 'claude-code:s1')).rejects.toThrow();
    await expect(open(keysA, sealed, 'claude-code:s2')).rejects.toThrow();
    const parts = sealed.split('.');
    const ct = fromBase64Url(parts[3]!);
    ct[0] = ct[0]! ^ 1;
    await expect(open(keysA, [...parts.slice(0, 3), toBase64Url(ct)].join('.'), 'claude-code:s1')).rejects.toThrow();
  });

  it('key id tells which key sealed the ciphertext', async () => {
    const sealed = await seal(keysA, 'x', 's');
    expect(sealedWith(keysA, sealed)).toBe(true);
    expect(sealedWith(keysB, sealed)).toBe(false);
  });

  it('same master key derives the same keys (opens on other devices too)', async () => {
    const master = generateMasterKey();
    const [k1, k2] = [await deriveKeys(master), await deriveKeys(new Uint8Array(master))];
    expect(k1.kid).toBe(k2.kid);
    expect(await open(k2, await seal(k1, '공유', 's'), 's')).toBe('공유');
  });

  it('rejects a key of the wrong length', async () => {
    await expect(deriveKeys(new Uint8Array(16))).rejects.toThrow();
  });
});

describe('tag', () => {
  it('same value gives the same tag, other value or key gives another, value is not revealed', async () => {
    const t = await tag(keysA, '회의 안건 3개 뽑아줘');
    expect(await tag(keysA, '회의 안건 3개 뽑아줘')).toBe(t);
    expect(await tag(keysA, '다른 요청')).not.toBe(t);
    expect(await tag(keysB, '회의 안건 3개 뽑아줘')).not.toBe(t);
    expect(t).toMatch(/^[\w-]{22}$/);
  });
});
