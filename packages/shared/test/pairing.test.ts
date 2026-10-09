import { describe, expect, it } from 'vitest';
import { deriveKeys, generateMasterKey, open, seal } from '../src/crypto.js';
import {
  exportPrivateKey,
  generateDeviceKeyPair,
  generatePairingSecret,
  importPrivateKey,
  PUBLIC_KEY_PATTERN,
  signPublicKey,
  unwrapMasterKey,
  verifyPublicKey,
  WRAPPED_PATTERN,
  wrapMasterKey,
} from '../src/pairing.js';

describe('기기 연결', () => {
  it('내용 키를 감싸 넘기면 받은 기기가 풀어서 같은 카드를 연다', async () => {
    const pc = await generateDeviceKeyPair(true);
    const phone = await generateDeviceKeyPair(false);
    expect(pc.publicKey).toMatch(PUBLIC_KEY_PATTERN);

    const master = generateMasterKey();
    const wrapped = await wrapMasterKey(master, pc.privateKey, phone.publicKey, 'pair-1');
    expect(wrapped).toMatch(WRAPPED_PATTERN);
    const received = await unwrapMasterKey(wrapped, phone.privateKey, pc.publicKey, 'pair-1');
    expect(received).toEqual(master);

    // 받은 키로 PC 가 만든 암호문이 열린다
    const sealed = await seal(await deriveKeys(master), '로그인 고쳐줘', 'claude-code:s1');
    expect(await open(await deriveKeys(received), sealed, 'claude-code:s1')).toBe('로그인 고쳐줘');
  });

  it('다른 기기·다른 연결 id·변조된 값으로는 풀리지 않는다', async () => {
    const [a, b, c] = await Promise.all([generateDeviceKeyPair(false), generateDeviceKeyPair(false), generateDeviceKeyPair(false)]);
    const wrapped = await wrapMasterKey(generateMasterKey(), a.privateKey, b.publicKey, 'pair-1');
    await expect(unwrapMasterKey(wrapped, c.privateKey, a.publicKey, 'pair-1')).rejects.toThrow();
    await expect(unwrapMasterKey(wrapped, b.privateKey, a.publicKey, 'pair-2')).rejects.toThrow();
    await expect(unwrapMasterKey(`${wrapped.slice(0, -2)}AA`, b.privateKey, a.publicKey, 'pair-1')).rejects.toThrow();
  });

  it('CLI 개인키는 파일로 저장했다가 다시 쓸 수 있다', async () => {
    const pc = await generateDeviceKeyPair(true);
    const phone = await generateDeviceKeyPair(false);
    const restored = await importPrivateKey(await exportPrivateKey(pc.privateKey));
    const master = generateMasterKey();
    const wrapped = await wrapMasterKey(master, phone.privateKey, pc.publicKey, 'p');
    expect(await unwrapMasterKey(wrapped, restored, phone.publicKey, 'p')).toEqual(master);
  });

  it('링크 비밀값 서명: 서버가 공개키를 바꿔치면 확인이 실패한다', async () => {
    const secret = generatePairingSecret();
    const real = await generateDeviceKeyPair(false);
    const fake = await generateDeviceKeyPair(false);
    const mac = await signPublicKey(secret, 'initiator', real.publicKey);
    expect(await verifyPublicKey(secret, 'initiator', real.publicKey, mac)).toBe(true);
    expect(await verifyPublicKey(secret, 'initiator', fake.publicKey, mac)).toBe(false); // 바꿔친 공개키
    expect(await verifyPublicKey(secret, 'responder', real.publicKey, mac)).toBe(false); // 역할이 다름
    expect(await verifyPublicKey(generatePairingSecret(), 'initiator', real.publicKey, mac)).toBe(false); // 비밀값 모름
    expect(await verifyPublicKey(secret, 'initiator', real.publicKey, 'garbage!')).toBe(false);
  });
});
