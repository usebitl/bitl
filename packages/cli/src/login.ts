import { spawn } from 'node:child_process';
import { hostname } from 'node:os';
import {
  deriveKeys,
  fromBase64Url,
  generateDeviceKeyPair,
  generatePairingSecret,
  signPublicKey,
  toBase64Url,
  unwrapMasterKey,
  verifyPublicKey,
  wrapMasterKey,
} from '@bitl/shared';
import { loadOrCreateMasterKey, readCloudConfig, removeCloudLogin, saveCloudLogin } from '@bitl/shared/node';
import { t } from './i18n.js';

/**
 * bitl login: connects this PC to a cloud account.
 *   1. Create this PC's key pair and start the connection by signing the public key with a one-time secret
 *   2. Open the approval link in a browser — the secret is only after the link's #, so the server never sees it
 *   3. Once approved, verify the browser's public key signature, then
 *      - receive the account key if the browser handed one over
 *      - if the account has no key yet, hand this PC's (local mode) key to the browser as the account key
 *   4. Save the device API key and account key to ~/.bitl → the collector sends to this account
 */

interface PollView {
  status: 'pending' | 'responded' | 'done' | 'denied';
  peer: { publicKey: string; mac: string } | null;
  wrapped: string | null;
  accountKeyId: string | null;
  device: { id: string; apiKey: string } | null;
  expiresAt: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function postJson(url: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }).catch((err) => {
    const origin = new URL(url).origin;
    const code = (err as { cause?: { code?: string } }).cause?.code;
    throw new Error(
      `${t('login.unreachable', { where: `${origin}${code ? `, ${code}` : ''}` })}\n${t('login.unreachableHint', { origin })}`,
    );
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

/** If the connection is abandoned midway, delete the just-created device */
async function revokeSelf(base: string, apiKey: string | undefined) {
  if (!apiKey) return;
  await fetch(`${base}/api/devices/me`, { method: 'DELETE', headers: { authorization: `Bearer ${apiKey}` } }).catch(() => {});
}

function openBrowser(url: string) {
  try {
    const [cmd, args] =
      process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    spawn(cmd as string, args as string[], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch {
    // If the browser can't be opened, the user can open the address manually
  }
}

export async function login(url: string, name = hostname(), opts: { openBrowser?: boolean } = {}): Promise<void> {
  const base = url.trim().replace(/\/+$/, '');
  const existing = readCloudConfig();
  if (existing) throw new Error(t('login.already', { url: existing.url, name: existing.name }));

  const secret = generatePairingSecret();
  const kp = await generateDeviceKeyPair(false);
  const mac = await signPublicKey(secret, 'initiator', kp.publicKey);
  const start = await postJson(`${base}/api/pairing/start`, { kind: 'cli', name, publicKey: kp.publicKey, mac });
  if (start.status === 404) throw new Error(t('login.notBitl', { url: base }));
  if (start.status === 429) throw new Error(t('login.tooMany'));
  if (start.status !== 200) throw new Error(t('login.cannotStart', { status: start.status }));
  const { id, pollToken, expiresAt, intervalMs, webUrl, apiUrl } = start.json as {
    id: string;
    pollToken: string;
    expiresAt: string;
    intervalMs: number;
    webUrl?: string;
    apiUrl?: string;
  };
  // Web and API may be different addresses (usebitl.com / api.usebitl.com) — approval on the web, events to the API
  const web = (webUrl ?? base).replace(/\/+$/, '');
  const api = (apiUrl ?? base).replace(/\/+$/, '');

  const link = `${web}/link?p=${encodeURIComponent(id)}#s=${secret}`;
  console.log(t('login.approve'));
  console.log(`  ${link}`);
  console.log(t('login.manual', { min: Math.round((Date.parse(expiresAt) - Date.now()) / 60_000) }));
  if (opts.openBrowser !== false) openBrowser(link);

  let view: PollView | undefined;
  while (Date.now() < Date.parse(expiresAt)) {
    await sleep(intervalMs || 2000);
    const r = await postJson(`${base}/api/pairing/${encodeURIComponent(id)}/poll`, { pollToken }).catch(() => undefined);
    if (!r) continue; // keep waiting through brief network drops
    if (r.status === 404) throw new Error(t('login.expired'));
    view = r.json as unknown as PollView;
    if (view.status !== 'pending') break;
  }
  if (!view || view.status === 'pending') throw new Error(t('login.timeout'));
  if (view.status === 'denied') throw new Error(t('login.denied'));

  const apiKey = view.device?.apiKey;
  if (!view.device || !view.peer) throw new Error(t('login.noResult'));
  // A public key injected by the server would fail the signature check — stop without exchanging keys
  if (!(await verifyPublicKey(secret, 'responder', view.peer.publicKey, view.peer.mac))) {
    await revokeSelf(base, apiKey);
    throw new Error(t('login.badSignature'));
  }

  let masterB64: string;
  if (view.wrapped) {
    masterB64 = toBase64Url(await unwrapMasterKey(view.wrapped, kp.privateKey, view.peer.publicKey, id));
  } else if (view.accountKeyId) {
    await revokeSelf(base, apiKey);
    throw new Error(t('login.noKeyBrowser'));
  } else {
    // First device on the account: use this PC's key (the one used in local mode) as the account key
    masterB64 = loadOrCreateMasterKey();
    const master = fromBase64Url(masterB64);
    const keys = await deriveKeys(master);
    const wrapped = await wrapMasterKey(master, kp.privateKey, view.peer.publicKey, id);
    const d = await postJson(`${base}/api/pairing/${encodeURIComponent(id)}/initiator-deliver`, { pollToken, wrapped, keyId: keys.kid });
    if (d.status !== 200) {
      await revokeSelf(base, apiKey);
      throw new Error(d.json.error === 'key-mismatch' ? t('login.keyMismatch') : t('login.deliverFailed', { status: d.status }));
    }
  }

  saveCloudLogin({ url: api, deviceId: view.device.id, apiKey: view.device.apiKey, name }, masterB64);
  console.log(`\n${t('login.connected', { name, web, via: api !== web ? t('login.via', { api }) : '' })}`);
  console.log(t('login.next'));
}

export async function logout(): Promise<void> {
  const cfg = readCloudConfig();
  if (!cfg) return console.log(t('logout.notConnected'));
  await revokeSelf(cfg.url, cfg.apiKey);
  removeCloudLogin();
  console.log(t('logout.done', { url: cfg.url, name: cfg.name }));
}
