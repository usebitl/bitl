import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type ContentKeys, keysFromBase64Url } from '../crypto.js';
import { bitlHome, loadKeys } from './keys.js';

/**
 * 이 PC 가 클라우드 계정에 연결됐는지 (bitl login). 연결됐으면 수집기·CLI 는 그 계정으로 보낸다.
 *   $BITL_HOME/cloud.json  { url, deviceId, apiKey, name }  — API 키가 들어 있어 이 사용자만 읽게 만든다
 *   $BITL_HOME/cloud-key   계정 내용 키 (로컬 모드의 key 와 같을 수도, 다를 수도 있다)
 */
export interface CloudConfig {
  url: string;
  deviceId: string;
  apiKey: string;
  name: string;
}

export const cloudConfigPath = (home = bitlHome()) => join(home, 'cloud.json');
export const cloudKeyPath = (home = bitlHome()) => join(home, 'cloud-key');

function writePrivate(file: string, text: string) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text, { encoding: 'utf8', mode: 0o600 });
}

export function readCloudConfig(home = bitlHome()): CloudConfig | null {
  try {
    const c = JSON.parse(readFileSync(cloudConfigPath(home), 'utf8')) as Partial<CloudConfig>;
    return c.url && c.deviceId && c.apiKey ? (c as CloudConfig) : null;
  } catch {
    return null;
  }
}

export function saveCloudLogin(cfg: CloudConfig, masterB64: string, home = bitlHome()) {
  writePrivate(cloudKeyPath(home), masterB64 + '\n');
  writePrivate(cloudConfigPath(home), JSON.stringify(cfg, null, 2) + '\n');
}

export function removeCloudLogin(home = bitlHome()) {
  rmSync(cloudConfigPath(home), { force: true });
  rmSync(cloudKeyPath(home), { force: true });
}

/**
 * 이 PC 의 bitl 버전 — 웹의 기기 화면이 업데이트가 필요한 PC 를 알려 주는 데 쓴다.
 * npm 패키지 빌드(cli/npm/build.mjs)가 BITL_CLIENT_VERSION 을 넣는다. 저장소에서 돌리면 없음
 */
export function clientVersionHeader(): Record<string, string> {
  const v = process.env.BITL_CLIENT_VERSION;
  return v ? { 'x-bitl-client': v } : {};
}

/** 보낼 곳: 클라우드 계정(연결됐으면) 또는 이 PC 의 로컬 서버 */
export interface Target {
  kind: 'cloud' | 'local';
  url: string;
  headers: Record<string, string>;
  keys: () => Promise<ContentKeys>;
}

export function resolveTarget(home = bitlHome()): Target {
  const cloud = readCloudConfig(home);
  if (cloud) {
    return {
      kind: 'cloud',
      url: cloud.url.replace(/\/+$/, ''),
      headers: { authorization: `Bearer ${cloud.apiKey}`, ...clientVersionHeader() },
      keys: () => keysFromBase64Url(readFileSync(cloudKeyPath(home), 'utf8')),
    };
  }
  return {
    kind: 'local',
    url: (process.env.BITL_URL?.trim() || `http://127.0.0.1:${process.env.BITL_PORT ?? 7777}`).replace(/\/+$/, ''),
    headers: {},
    keys: () => loadKeys(home),
  };
}
