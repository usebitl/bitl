// Content encryption — the adapters (Node) and the browser share this code (WebCrypto: globalThis.crypto.subtle).
//
// One account content key (32-byte master) yields per-purpose keys via HKDF:
//   enc: AES-256-GCM — each field encrypted separately
//   tag: HMAC-SHA-256 — lets the server compare only "is it the same value" (e.g. same request)
//   kid: key identifier — to recognize values encrypted with a different key
//
// Ciphertext format: v1.<kid>.<iv>.<ciphertext+tag>  (all base64url)
// The session key (`source:sessionId`) is bound as AAD — if the server moves a ciphertext to another session, decryption fails.
// Plaintext is padded to 32-byte blocks (ISO/IEC 7816-4) so the length of short values isn't revealed as is.
//
// Inbox format for cloud sessions (remote MCP): s1.<ephemeral public key>.<iv>.<ciphertext+tag>
//   Claude in the cloud can't hold the account key, so it sends content to the server in plaintext. The server immediately
//   locks it with the account's inbox public key and discards the original (ECDH P-256 ephemeral key → HKDF → AES-256-GCM, AAD is the same session key).
//   The private key is sealed with the account key, so only my devices can open it — the server can lock but not open.

export type Sealed = string;

export interface ContentKeys {
  enc: CryptoKey;
  tag: CryptoKey;
  kid: string;
  /** The master key itself — needed to wrap and hand it to another device (pairing.ts) */
  master: Uint8Array<ArrayBuffer>;
  /** Inbox private key (ECDH) — if present, also opens cloud session (s1.) content */
  inbox?: CryptoKey;
}

/** Produces sealed content and tags for sessions, turns and events. Tests may use an implementation that leaves plaintext as is */
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

/** Master key → per-purpose keys. The derived keys are non-extractable (can be stored as is in browser IndexedDB) */
export async function deriveKeys(master: Uint8Array): Promise<ContentKeys> {
  if (master.length !== MASTER_KEY_BYTES) throw new Error(`key length is not ${MASTER_KEY_BYTES} bytes`);
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

/** Whether the ciphertext was made with this key (compares the identifier only, without decrypting) */
export const sealedWith = (keys: Pick<ContentKeys, 'kid'>, sealed: Sealed): boolean => sealed.split('.')[1] === keys.kid;

/** Decrypt. Throws on a different key, a different session (AAD), or a tampered value */
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

// ── Inbox (cloud sessions) ──────────────────────────────────

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

/** Create an inbox key pair. The public key (raw, base64url) goes to the server; the private key (pkcs8, base64url) is sealed with the account key and left with the server */
export async function generateInboxKeyPair(): Promise<{ publicKey: string; privateKeyPkcs8: string }> {
  const kp = (await subtle().generateKey(INBOX_CURVE, true, ['deriveBits'])) as CryptoKeyPair;
  return {
    publicKey: toBase64Url(new Uint8Array(await subtle().exportKey('raw', kp.publicKey))),
    privateKeyPkcs8: toBase64Url(new Uint8Array(await subtle().exportKey('pkcs8', kp.privateKey))),
  };
}

/** Into a CryptoKey whose private key can't be extracted (the browser keeps only this in IndexedDB/memory) */
export const importInboxPrivateKey = (pkcs8: string): Promise<CryptoKey> =>
  subtle().importKey('pkcs8', fromBase64Url(pkcs8), INBOX_CURVE, false, ['deriveBits']);

/** Server: locks received plaintext with the inbox public key. Creates a fresh ephemeral key every time */
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

/** Browser: a new inbox key pair — private key sealed with the account key (to be left with the server) */
export async function createInboxKey(keys: ContentKeys): Promise<{ publicKey: string; wrappedPrivateKey: Sealed }> {
  const { publicKey, privateKeyPkcs8 } = await generateInboxKeyPair();
  return { publicKey, wrappedPrivateKey: await seal(keys, privateKeyPkcs8, INBOX_WRAP_AAD) };
}

/** Opens the sealed private key left with the server (only opens with the right account key) */
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

/** Same value, same tag. The server compares equality without knowing the value */
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
