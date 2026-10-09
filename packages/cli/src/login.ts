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
 * bitl login: 이 PC 를 클라우드 계정에 연결한다.
 *   1. 이 PC 의 키쌍을 만들고, 1회용 비밀값으로 공개키에 서명해 연결을 시작한다
 *   2. 브라우저로 승인 링크를 연다 — 비밀값은 링크의 # 뒤에만 있어 서버는 모른다
 *   3. 승인되면 브라우저의 공개키 서명을 확인한 뒤
 *      - 브라우저가 계정 키를 넘겼으면 받고
 *      - 계정에 아직 키가 없으면 이 PC 의 (로컬 모드) 키를 계정 키로 브라우저에 넘긴다
 *   4. 기기 API 키와 계정 키를 ~/.bitl 에 저장 → 수집기가 이 계정으로 보낸다
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

/** 연결을 중간에 그만두면 방금 만들어진 기기를 지운다 */
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
    // 브라우저를 못 열면 주소를 직접 열면 된다
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
  // 웹과 API 가 다른 주소일 수 있다 (usebitl.com / api.usebitl.com) — 승인은 웹에서, 이벤트는 API 로
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
    if (!r) continue; // 네트워크가 잠깐 끊겨도 계속 기다린다
    if (r.status === 404) throw new Error(t('login.expired'));
    view = r.json as unknown as PollView;
    if (view.status !== 'pending') break;
  }
  if (!view || view.status === 'pending') throw new Error(t('login.timeout'));
  if (view.status === 'denied') throw new Error(t('login.denied'));

  const apiKey = view.device?.apiKey;
  if (!view.device || !view.peer) throw new Error(t('login.noResult'));
  // 서버가 끼워 넣은 공개키라면 서명이 맞지 않는다 — 키를 주고받지 않고 멈춘다
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
    // 계정의 첫 기기: 이 PC 의 키(로컬 모드에서 쓰던 것)를 계정 키로 쓴다
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
  // npm 패키지(클라우드 전용)에는 로컬 서버가 없다
  console.log(t(process.env.BITL_CLOUD_ONLY === '1' ? 'logout.doneCloud' : 'logout.done', { url: cfg.url, name: cfg.name }));
}
