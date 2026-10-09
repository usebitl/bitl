import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { type ContentKeys, generateMasterKey, keysFromBase64Url, toBase64Url } from '../crypto.js';

/**
 * 계정 내용 키 (로컬 모드). 이 PC 에서 처음 필요할 때 만든다.
 * 브라우저에는 `bitl pair` 가 보여주는 링크(#key=…)로 한 번 넘긴다 — 주소의 # 뒤는 서버로 전송되지 않는다.
 * 클라우드 서버 단계(Phase 4)에서는 기기 키쌍 + QR 로 넘기는 방식으로 바뀐다.
 */

/** 빈 문자열이면 설정하지 않은 것으로 본다 */
export const bitlHome = (env = process.env.BITL_HOME): string => (env?.trim() ? env.trim() : join(homedir(), '.bitl'));
export const keyPath = (home = bitlHome()) => join(home, 'key');

/** base64url 마스터 키. BITL_KEY 가 있으면 그것 (클라우드 세션 등 키 파일이 없는 환경용) */
export function loadOrCreateMasterKey(home = bitlHome(), env = process.env.BITL_KEY): string {
  if (env?.trim()) return env.trim();
  const file = keyPath(home);
  try {
    const existing = readFileSync(file, 'utf8').trim();
    if (existing) return existing;
  } catch {
    // 아직 없음
  }
  const key = toBase64Url(generateMasterKey());
  mkdirSync(dirname(file), { recursive: true });
  try {
    // hook 여러 개가 동시에 처음 실행돼도 키가 하나만 생기도록 'wx' (이미 있으면 실패)
    writeFileSync(file, key + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    return key;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return readFileSync(file, 'utf8').trim();
    throw err;
  }
}

export const loadKeys = (home = bitlHome()): Promise<ContentKeys> => keysFromBase64Url(loadOrCreateMasterKey(home));
