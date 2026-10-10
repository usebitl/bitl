import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type ContentKeys, keysFromBase64Url } from '../crypto.js';
import { bitlHome, loadKeys } from './keys.js';

/**
 * Whether this PC is linked to a cloud account (bitl login). If linked, the collectors and CLI send to that account.
 *   $BITL_HOME/cloud.json  { url, deviceId, apiKey, name }  — contains the API key, so it's readable only by this user
 *   $BITL_HOME/cloud-key   account content key (may or may not be the same as the local mode key)
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
 * This PC's bitl version — the web devices screen uses it to flag PCs that need an update.
 * The npm package build (cli/npm/build.mjs) injects BITL_CLIENT_VERSION. Absent when run from the repo
 */
export function clientVersionHeader(): Record<string, string> {
  const v = process.env.BITL_CLIENT_VERSION;
  return v ? { 'x-bitl-client': v } : {};
}

/** Destination: the cloud account (if linked) or this PC's local server */
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
