// 기기 연결: 계정 내용 키를 기기끼리 넘긴다. 서버는 감싼(암호화한) 키를 전달만 한다.
//
// - 기기마다 ECDH P-256 키쌍. 내용 키는 ECDH(내 개인키, 상대 공개키) → HKDF → AES-GCM 으로 감싸 보낸다 (AAD = 연결 id)
// - 서버가 가짜 공개키를 끼워 넣지 못하게: 사용자가 여는 링크(QR)의 # 뒤 비밀값(서버로 가지 않는다)으로
//   양쪽이 자기 공개키에 서명(HMAC)하고, 상대 서명을 확인한다. 확인이 안 되면 키를 넘기지 않는다
//
// Node(CLI)·브라우저 공용 (WebCrypto).
import { fromBase64Url, MASTER_KEY_BYTES, toBase64Url } from './crypto.js';

type Bytes = Uint8Array<ArrayBuffer>;
const subtle = () => globalThis.crypto.subtle;
const utf8 = new TextEncoder();
const CURVE = { name: 'ECDH', namedCurve: 'P-256' } as const;

/** P-256 공개키(압축하지 않은 65바이트)의 base64url */
export const PUBLIC_KEY_PATTERN = /^[A-Za-z0-9_-]{87}$/;
export const WRAPPED_PATTERN = /^w1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/;
export const PAIRING_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export type PairingRole = 'initiator' | 'responder';

export interface DeviceKeyPair {
  publicKey: string;
  privateKey: CryptoKey;
}

/** extractable: CLI 는 파일에 저장해야 해서 true, 브라우저는 IndexedDB 에 CryptoKey 그대로 두므로 false */
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

/** 링크 # 뒤에 싣는 1회용 비밀값 */
export const generatePairingSecret = (): string => toBase64Url(globalThis.crypto.getRandomValues(new Uint8Array(32)));

const macKey = (secret: string) => subtle().importKey('raw', fromBase64Url(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
const macInput = (role: PairingRole, publicKey: string) => utf8.encode(`bitl/v1/pair|${role}|${publicKey}`);

/** "이 공개키는 링크를 가진 쪽이 보낸 것" 서명 */
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

/** 내용 키(마스터)를 상대 기기용으로 감싼다. 형식: w1.<iv>.<ct> */
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
