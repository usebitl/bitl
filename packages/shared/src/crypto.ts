// 내용 암호화 — 어댑터(Node)와 브라우저가 같은 코드를 쓴다 (WebCrypto: globalThis.crypto.subtle).
//
// 계정 내용 키(마스터 32바이트) 하나에서 HKDF 로 용도별 키를 만든다:
//   enc: AES-256-GCM — 필드마다 따로 암호화
//   tag: HMAC-SHA-256 — "같은 값인가"만 서버가 비교할 수 있게 (예: 같은 요청인지)
//   kid: 키 식별자 — 다른 키로 암호화된 값을 알아보기 위해
//
// 암호문 형식: v1.<kid>.<iv>.<ciphertext+tag>  (모두 base64url)
// AAD 로 세션 키(`source:sessionId`)를 묶는다 — 서버가 암호문을 다른 세션으로 옮겨 붙이면 복호화가 실패한다.
// 평문은 32바이트 단위로 패딩해서(ISO/IEC 7816-4) 짧은 값의 길이가 그대로 드러나지 않게 한다.
//
// 클라우드 세션(원격 MCP)용 받은편지함 형식: s1.<일회용 공개키>.<iv>.<ciphertext+tag>
//   클라우드의 Claude 는 계정 키를 가질 수 없어 내용을 평문으로 서버에 보낸다. 서버는 받자마자 계정의 받은편지함 공개키로
//   잠그고 원문을 버린다 (ECDH P-256 일회용 키 → HKDF → AES-256-GCM, AAD 는 같은 세션 키).
//   개인키는 계정 키로 봉인돼 있어 내 기기만 연다 — 서버는 잠글 수만 있고 열 수 없다.

export type Sealed = string;

export interface ContentKeys {
  enc: CryptoKey;
  tag: CryptoKey;
  kid: string;
  /** 마스터 키 자체 — 다른 기기에 감싸서 넘길 때 필요하다 (pairing.ts) */
  master: Uint8Array<ArrayBuffer>;
  /** 받은편지함 개인키 (ECDH) — 있으면 클라우드 세션(s1.) 내용도 연다 */
  inbox?: CryptoKey;
}

/** 세션·턴·이벤트 내용과 태그를 만드는 쪽. 테스트에서는 평문 그대로 두는 구현을 쓸 수 있다 */
export interface Sealer {
  seal(plaintext: string, aad: string): Promise<Sealed>;
  tag(value: string): Promise<string>;
}

export const MASTER_KEY_BYTES = 32;
const VERSION = 'v1';
const PAD_BLOCK = 32;
const TAG_BYTES = 16;
export const SEALED_PATTERN = /^v1\.[A-Za-z0-9_-]{8}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/;
export const INBOX_SEALED_PATTERN = /^s1\.[A-Za-z0-9_-]{87}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/;

const subtle = () => globalThis.crypto.subtle;
type Bytes = Uint8Array<ArrayBuffer>;
const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder('utf-8', { fatal: true });

export function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(s: string): Bytes {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('invalid base64url');
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export const generateMasterKey = (): Bytes => globalThis.crypto.getRandomValues(new Uint8Array(MASTER_KEY_BYTES));

const info = (name: string) => ({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: utf8.encode(`bitl/v1/${name}`) });

/** 마스터 키 → 용도별 키. 만든 키는 추출할 수 없다 (브라우저 IndexedDB 에 그대로 보관 가능) */
export async function deriveKeys(master: Uint8Array): Promise<ContentKeys> {
  if (master.length !== MASTER_KEY_BYTES) throw new Error(`키 길이가 ${MASTER_KEY_BYTES}바이트가 아닙니다`);
  const base = await subtle().importKey('raw', new Uint8Array(master), 'HKDF', false, ['deriveKey', 'deriveBits']);
  const [enc, tag, kidBits] = await Promise.all([
    subtle().deriveKey(info('enc'), base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']),
    subtle().deriveKey(info('tag'), base, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign']),
    subtle().deriveBits(info('kid'), base, 48),
  ]);
  return { enc, tag, kid: toBase64Url(new Uint8Array(kidBits)), master: new Uint8Array(master) };
}

function pad(bytes: Uint8Array): Bytes {
  const out = new Uint8Array(Math.ceil((bytes.length + 1) / PAD_BLOCK) * PAD_BLOCK);
  out.set(bytes);
  out[bytes.length] = 0x80;
  return out;
}

function unpad(bytes: Uint8Array): Uint8Array {
  let i = bytes.length - 1;
  while (i >= 0 && bytes[i] === 0) i--;
  if (i < 0 || bytes[i] !== 0x80) throw new Error('invalid padding');
  return bytes.subarray(0, i);
}

export async function seal(keys: ContentKeys, plaintext: string, aad: string): Promise<Sealed> {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: utf8.encode(aad) }, keys.enc, pad(utf8.encode(plaintext)));
  return `${VERSION}.${keys.kid}.${toBase64Url(iv)}.${toBase64Url(new Uint8Array(ct))}`;
}

/** 이 키로 만든 암호문인지 (복호화하지 않고 식별자만 비교) */
export const sealedWith = (keys: Pick<ContentKeys, 'kid'>, sealed: Sealed): boolean => sealed.split('.')[1] === keys.kid;

/** 복호화. 다른 키, 다른 세션(AAD), 변조된 값이면 예외 */
export async function open(keys: ContentKeys, sealed: Sealed, aad: string): Promise<string> {
  if (sealed.startsWith('s1.')) {
    if (!keys.inbox) throw new Error('no inbox key');
    return openInbox(keys.inbox, sealed, aad);
  }
  const parts = sealed.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) throw new Error('unknown format');
  if (parts[1] !== keys.kid) throw new Error('different key');
  const pt = await subtle().decrypt(
    { name: 'AES-GCM', iv: fromBase64Url(parts[2]!), additionalData: utf8.encode(aad) },
    keys.enc,
    fromBase64Url(parts[3]!),
  );
  return fromUtf8.decode(unpad(new Uint8Array(pt)));
}

// ── 받은편지함 (클라우드 세션) ──────────────────────────────────

const INBOX_CURVE = { name: 'ECDH', namedCurve: 'P-256' } as const;

async function inboxKey(shared: ArrayBuffer, ephemeralPublic: Uint8Array, usage: KeyUsage): Promise<CryptoKey> {
  const base = await subtle().importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  return subtle().deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(ephemeralPublic) as Bytes, info: utf8.encode('bitl/v1/inbox') },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    [usage],
  );
}

/** 받은편지함 키쌍 만들기. 공개키(raw, base64url)는 서버에, 개인키(pkcs8, base64url)는 계정 키로 봉인해 서버에 맡긴다 */
export async function generateInboxKeyPair(): Promise<{ publicKey: string; privateKeyPkcs8: string }> {
  const kp = (await subtle().generateKey(INBOX_CURVE, true, ['deriveBits'])) as CryptoKeyPair;
  return {
    publicKey: toBase64Url(new Uint8Array(await subtle().exportKey('raw', kp.publicKey))),
    privateKeyPkcs8: toBase64Url(new Uint8Array(await subtle().exportKey('pkcs8', kp.privateKey))),
  };
}

/** 개인키를 꺼낼 수 없는 CryptoKey 로 (브라우저는 이것만 IndexedDB·메모리에 둔다) */
export const importInboxPrivateKey = (pkcs8: string): Promise<CryptoKey> =>
  subtle().importKey('pkcs8', fromBase64Url(pkcs8), INBOX_CURVE, false, ['deriveBits']);

/** 서버: 받은 평문을 받은편지함 공개키로 잠근다. 매번 일회용 키를 새로 만든다 */
export async function sealInbox(inboxPublicKey: string, plaintext: string, aad: string): Promise<Sealed> {
  const peer = await subtle().importKey('raw', fromBase64Url(inboxPublicKey), INBOX_CURVE, false, []);
  const eph = (await subtle().generateKey(INBOX_CURVE, true, ['deriveBits'])) as CryptoKeyPair;
  const ephRaw = new Uint8Array(await subtle().exportKey('raw', eph.publicKey));
  const shared = await subtle().deriveBits({ name: 'ECDH', public: peer }, eph.privateKey, 256);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle().encrypt(
    { name: 'AES-GCM', iv, additionalData: utf8.encode(aad) },
    await inboxKey(shared, ephRaw, 'encrypt'),
    pad(utf8.encode(plaintext)),
  );
  return `s1.${toBase64Url(ephRaw)}.${toBase64Url(iv)}.${toBase64Url(new Uint8Array(ct))}`;
}

const INBOX_WRAP_AAD = 'bitl/inbox-key';

/** 브라우저: 새 받은편지함 키쌍 — 개인키는 계정 키로 봉인해서 (서버에 맡길 것) */
export async function createInboxKey(keys: ContentKeys): Promise<{ publicKey: string; wrappedPrivateKey: Sealed }> {
  const { publicKey, privateKeyPkcs8 } = await generateInboxKeyPair();
  return { publicKey, wrappedPrivateKey: await seal(keys, privateKeyPkcs8, INBOX_WRAP_AAD) };
}

/** 서버에 맡긴 봉인된 개인키를 연다 (계정 키가 맞아야 열린다) */
export async function unwrapInboxKey(keys: ContentKeys, wrappedPrivateKey: Sealed): Promise<CryptoKey> {
  return importInboxPrivateKey(await open(keys, wrappedPrivateKey, INBOX_WRAP_AAD));
}

async function openInbox(privateKey: CryptoKey, sealed: Sealed, aad: string): Promise<string> {
  const parts = sealed.split('.');
  if (parts.length !== 4 || !INBOX_SEALED_PATTERN.test(sealed)) throw new Error('unknown format');
  const ephRaw = fromBase64Url(parts[1]!);
  const peer = await subtle().importKey('raw', ephRaw, INBOX_CURVE, false, []);
  const shared = await subtle().deriveBits({ name: 'ECDH', public: peer }, privateKey, 256);
  const pt = await subtle().decrypt(
    { name: 'AES-GCM', iv: fromBase64Url(parts[2]!), additionalData: utf8.encode(aad) },
    await inboxKey(shared, ephRaw, 'decrypt'),
    fromBase64Url(parts[3]!),
  );
  return fromUtf8.decode(unpad(new Uint8Array(pt)));
}

/** 같은 값이면 같은 태그. 서버는 값은 모른 채 같은지만 비교한다 */
export async function tag(keys: ContentKeys, value: string): Promise<string> {
  const mac = await subtle().sign('HMAC', keys.tag, utf8.encode(value));
  return toBase64Url(new Uint8Array(mac).subarray(0, TAG_BYTES));
}

export const sealerFor = (keys: ContentKeys): Sealer => ({
  seal: (plaintext, aad) => seal(keys, plaintext, aad),
  tag: (value) => tag(keys, value),
});

export async function keysFromBase64Url(master: string): Promise<ContentKeys> {
  return deriveKeys(fromBase64Url(master.trim()));
}
