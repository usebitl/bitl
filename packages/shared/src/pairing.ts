// Device pairing: hands the account content key from device to device. The server only relays the wrapped (encrypted) key.
//
// - Each device has an ECDH P-256 key pair. The content key is wrapped via ECDH(my private key, peer public key) → HKDF → AES-GCM (AAD = pairing id)
// - So the server can't inject a fake public key: with the secret after # in the link (QR) the user opens (never sent to the server),
//   each side signs its own public key (HMAC) and verifies the peer's signature. If verification fails, the key isn't handed over
//
// Shared by Node (CLI) and browser (WebCrypto).
import { fromBase64Url, MASTER_KEY_BYTES, toBase64Url } from './crypto.js';

type Bytes = Uint8Array<ArrayBuffer>;
const subtle = () => globalThis.crypto.subtle;
const utf8 = new TextEncoder();
const CURVE = { name: 'ECDH', namedCurve: 'P-256' } as const;

/** base64url of a P-256 public key (uncompressed, 65 bytes) */
export const PUBLIC_KEY_PATTERN = /^[A-Za-z0-9_-]{87}$/;
export const WRAPPED_PATTERN = /^w1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/;
export const PAIRING_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export type PairingRole = 'initiator' | 'responder';

export interface DeviceKeyPair {
  publicKey: string;
  privateKey: CryptoKey;
}

/** extractable: true for the CLI since it saves to a file; false for the browser, which keeps the CryptoKey as is in IndexedDB */
export async function generateDeviceKeyPair(extractable: boolean): Promise<DeviceKeyPair> {
  const kp = (await subtle().generateKey(CURVE, extractable, ['deriveBits'])) as CryptoKeyPair;
  const raw = new Uint8Array(await subtle().exportKey('raw', kp.publicKey));
  return { publicKey: toBase64Url(raw), privateKey: kp.privateKey };
}

export async function exportPrivateKey(key: CryptoKey): Promise<string> {
  return toBase64Url(new Uint8Array(await subtle().exportKey('pkcs8', key)));
}

export function importPrivateKey(pkcs8: string): Promise<CryptoKey> {
  return subtle().importKey('pkcs8', fromBase64Url(pkcs8), CURVE, false, ['deriveBits']);
}

const importPublicKey = (publicKey: string) => subtle().importKey('raw', fromBase64Url(publicKey), CURVE, false, []);

/** One-time secret carried after # in the link */
export const generatePairingSecret = (): string => toBase64Url(globalThis.crypto.getRandomValues(new Uint8Array(32)));

const macKey = (secret: string) => subtle().importKey('raw', fromBase64Url(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
const macInput = (role: PairingRole, publicKey: string) => utf8.encode(`bitl/v1/pair|${role}|${publicKey}`);

/** Signature meaning "this public key was sent by the side holding the link" */
export async function signPublicKey(secret: string, role: PairingRole, publicKey: string): Promise<string> {
  return toBase64Url(new Uint8Array(await subtle().sign('HMAC', await macKey(secret), macInput(role, publicKey))));
}

export async function verifyPublicKey(secret: string, role: PairingRole, publicKey: string, mac: string): Promise<boolean> {
  try {
    return await subtle().verify('HMAC', await macKey(secret), fromBase64Url(mac), macInput(role, publicKey));
  } catch {
    return false;
  }
}

async function wrappingKey(ownPrivate: CryptoKey, peerPublic: string, pairingId: string, usage: KeyUsage): Promise<CryptoKey> {
  const shared = await subtle().deriveBits({ name: 'ECDH', public: await importPublicKey(peerPublic) }, ownPrivate, 256);
  const base = await subtle().importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  return subtle().deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: utf8.encode(`bitl/v1/wrap|${pairingId}`) },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    [usage],
  );
}

/** Wraps the content (master) key for the peer device. Format: w1.<iv>.<ct> */
export async function wrapMasterKey(master: Uint8Array, ownPrivate: CryptoKey, peerPublic: string, pairingId: string): Promise<string> {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const key = await wrappingKey(ownPrivate, peerPublic, pairingId, 'encrypt');
  const ct = await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: utf8.encode(pairingId) }, key, new Uint8Array(master) as Bytes);
  return `w1.${toBase64Url(iv)}.${toBase64Url(new Uint8Array(ct))}`;
}

export async function unwrapMasterKey(wrapped: string, ownPrivate: CryptoKey, peerPublic: string, pairingId: string): Promise<Bytes> {
  const [v, iv, ct] = wrapped.split('.');
  if (v !== 'w1' || !iv || !ct) throw new Error('unknown wrapped key format');
  const key = await wrappingKey(ownPrivate, peerPublic, pairingId, 'decrypt');
  const master = new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: fromBase64Url(iv), additionalData: utf8.encode(pairingId) }, key, fromBase64Url(ct)));
  if (master.length !== MASTER_KEY_BYTES) throw new Error('wrapped key has wrong length');
  return master;
}
