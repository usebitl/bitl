import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { type ContentKeys, generateMasterKey, keysFromBase64Url, toBase64Url } from '../crypto.js';

/**
 * Account content key (local mode). Created on this PC the first time it's needed.
 * Handed to the browser once via the link `bitl pair` shows (#key=…) — the part after # in a URL is never sent to the server.
 * In the cloud server phase (Phase 4) this changes to handing it over with device key pairs + QR.
 */

/** An empty string counts as not set */
export const bitlHome = (env = process.env.BITL_HOME): string => (env?.trim() ? env.trim() : join(homedir(), '.bitl'));
export const keyPath = (home = bitlHome()) => join(home, 'key');

/** base64url master key. BITL_KEY if set (for environments without a key file, e.g. cloud sessions) */
export function loadOrCreateMasterKey(home = bitlHome(), env = process.env.BITL_KEY): string {
  if (env?.trim()) return env.trim();
  const file = keyPath(home);
  try {
    const existing = readFileSync(file, 'utf8').trim();
    if (existing) return existing;
  } catch {
    // doesn't exist yet
  }
  const key = toBase64Url(generateMasterKey());
  mkdirSync(dirname(file), { recursive: true });
  try {
    // 'wx' (fails if it already exists) so only one key is created even if several hooks run for the first time at once
    writeFileSync(file, key + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    return key;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return readFileSync(file, 'utf8').trim();
    throw err;
  }
}

export const loadKeys = (home = bitlHome()): Promise<ContentKeys> => keysFromBase64Url(loadOrCreateMasterKey(home));
