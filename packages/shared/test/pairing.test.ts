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

describe('device pairing', () => {
  it('a wrapped content key is unwrapped by the receiving device, which opens the same cards', async () => {
    const pc = await generateDeviceKeyPair(true);
    const phone = await generateDeviceKeyPair(false);
    expect(pc.publicKey).toMatch(PUBLIC_KEY_PATTERN);

    const master = generateMasterKey();
    const wrapped = await wrapMasterKey(master, pc.privateKey, phone.publicKey, 'pair-1');
    expect(wrapped).toMatch(WRAPPED_PATTERN);
    const received = await unwrapMasterKey(wrapped, phone.privateKey, pc.publicKey, 'pair-1');
    expect(received).toEqual(master);

    // the received key opens ciphertext made by the PC
    const sealed = await seal(await deriveKeys(master), '로그인 고쳐줘', 'claude-code:s1');
    expect(await open(await deriveKeys(received), sealed, 'claude-code:s1')).toBe('로그인 고쳐줘');
  });

  it('does not unwrap with another device, another pairing id, or a tampered value', async () => {
    const [a, b, c] = await Promise.all([generateDeviceKeyPair(false), generateDeviceKeyPair(false), generateDeviceKeyPair(false)]);
    const wrapped = await wrapMasterKey(generateMasterKey(), a.privateKey, b.publicKey, 'pair-1');
    await expect(unwrapMasterKey(wrapped, c.privateKey, a.publicKey, 'pair-1')).rejects.toThrow();
    await expect(unwrapMasterKey(wrapped, b.privateKey, a.publicKey, 'pair-2')).rejects.toThrow();
    await expect(unwrapMasterKey(`${wrapped.slice(0, -2)}AA`, b.privateKey, a.publicKey, 'pair-1')).rejects.toThrow();
  });

  it('the CLI private key can be saved to a file and reused', async () => {
    const pc = await generateDeviceKeyPair(true);
    const phone = await generateDeviceKeyPair(false);
    const restored = await importPrivateKey(await exportPrivateKey(pc.privateKey));
    const master = generateMasterKey();
    const wrapped = await wrapMasterKey(master, phone.privateKey, pc.publicKey, 'p');
    expect(await unwrapMasterKey(wrapped, restored, phone.publicKey, 'p')).toEqual(master);
  });

  it('link secret signature: verification fails if the server swaps the public key', async () => {
    const secret = generatePairingSecret();
    const real = await generateDeviceKeyPair(false);
    const fake = await generateDeviceKeyPair(false);
    const mac = await signPublicKey(secret, 'initiator', real.publicKey);
    expect(await verifyPublicKey(secret, 'initiator', real.publicKey, mac)).toBe(true);
    expect(await verifyPublicKey(secret, 'initiator', fake.publicKey, mac)).toBe(false); // swapped public key
    expect(await verifyPublicKey(secret, 'responder', real.publicKey, mac)).toBe(false); // wrong role
    expect(await verifyPublicKey(generatePairingSecret(), 'initiator', real.publicKey, mac)).toBe(false); // secret unknown
    expect(await verifyPublicKey(secret, 'initiator', real.publicKey, 'garbage!')).toBe(false);
  });
});
