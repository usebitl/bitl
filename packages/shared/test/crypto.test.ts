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
  it('왕복 (한글·이모지·줄바꿈·빈 문자열)', async () => {
    for (const text of ['로그인 버그 고쳐줘', 'emoji 🔒\n두 줄', '', ' 끝에 공백 ', 'x'.repeat(1000)]) {
      const sealed = await seal(keysA, text, 'claude-code:s1');
      expect(sealed).toMatch(SEALED_PATTERN);
      expect(await open(keysA, sealed, 'claude-code:s1')).toBe(text);
    }
  });

  it('암호문에 평문이 드러나지 않고, 같은 값도 매번 다르게 암호화된다', async () => {
    const a = await seal(keysA, 'pnpm test', 's');
    const b = await seal(keysA, 'pnpm test', 's');
    expect(a).not.toBe(b);
    expect(a).not.toContain('pnpm');
  });

  it('길이는 32바이트 단위로만 드러난다', async () => {
    const len = async (t: string) => (await seal(keysA, t, 's')).length;
    expect(await len('a')).toBe(await len('a'.repeat(31)));
    expect(await len('a'.repeat(32))).toBeGreaterThan(await len('a'.repeat(31)));
  });

  it('다른 키, 다른 세션(AAD), 변조된 값은 열리지 않는다', async () => {
    const sealed = await seal(keysA, '비밀', 'claude-code:s1');
    await expect(open(keysB, sealed, 'claude-code:s1')).rejects.toThrow();
    await expect(open(keysA, sealed, 'claude-code:s2')).rejects.toThrow();
    const parts = sealed.split('.');
    const ct = fromBase64Url(parts[3]!);
    ct[0] = ct[0]! ^ 1;
    await expect(open(keysA, [...parts.slice(0, 3), toBase64Url(ct)].join('.'), 'claude-code:s1')).rejects.toThrow();
  });

  it('키 식별자로 어느 키의 암호문인지 안다', async () => {
    const sealed = await seal(keysA, 'x', 's');
    expect(sealedWith(keysA, sealed)).toBe(true);
    expect(sealedWith(keysB, sealed)).toBe(false);
  });

  it('같은 마스터 키면 같은 키가 나온다 (다른 기기에서도 열림)', async () => {
    const master = generateMasterKey();
    const [k1, k2] = [await deriveKeys(master), await deriveKeys(new Uint8Array(master))];
    expect(k1.kid).toBe(k2.kid);
    expect(await open(k2, await seal(k1, '공유', 's'), 's')).toBe('공유');
  });

  it('길이가 틀린 키는 거부', async () => {
    await expect(deriveKeys(new Uint8Array(16))).rejects.toThrow();
  });
});

describe('tag', () => {
  it('같은 값은 같은 태그, 다른 값·다른 키는 다른 태그, 값이 드러나지 않음', async () => {
    const t = await tag(keysA, '회의 안건 3개 뽑아줘');
    expect(await tag(keysA, '회의 안건 3개 뽑아줘')).toBe(t);
    expect(await tag(keysA, '다른 요청')).not.toBe(t);
    expect(await tag(keysB, '회의 안건 3개 뽑아줘')).not.toBe(t);
    expect(t).toMatch(/^[\w-]{22}$/);
  });
});
