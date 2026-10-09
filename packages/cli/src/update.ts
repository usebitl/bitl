import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { compareVersions, VERSION_PATTERN } from '@bitl/shared';
import { bitlHome } from '@bitl/shared/node';
import { t } from './i18n.js';

/**
 * 새 버전 알림: 사용자가 직접 친 명령(status·install·login …)이 끝난 뒤 한 줄.
 * - npm 패키지에서만 (저장소 실행은 버전이 없다). hook·어댑터 경로에서는 부르지 않는다 — 에이전트를 늦추면 안 된다
 * - npm 레지스트리는 하루 한 번만 묻고, 1초 안에 답이 없으면 건너뛴다. 결과는 $BITL_HOME/update-check.json 에 둔다
 * - BITL_NO_UPDATE_CHECK=1 이면 끈다
 */
const REGISTRY = 'https://registry.npmjs.org/@usebitl/cli/latest';
const DAY = 86_400_000;
const TIMEOUT_MS = 1000;

interface Cache {
  checkedAt: string;
  latest?: string;
}

const cachePath = () => join(bitlHome(), 'update-check.json');

function readCache(): Cache | null {
  try {
    return JSON.parse(readFileSync(cachePath(), 'utf8')) as Cache;
  } catch {
    return null;
  }
}

async function fetchLatest(): Promise<string | undefined> {
  try {
    const res = await fetch(REGISTRY, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: 'application/json' } });
    if (!res.ok) return undefined;
    const v = ((await res.json()) as { version?: unknown }).version;
    return typeof v === 'string' && VERSION_PATTERN.test(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

/** 최신 버전 (하루 한 번 확인). 확인하지 못하면 마지막으로 안 값 */
async function latestVersion(now = Date.now()): Promise<string | undefined> {
  const cache = readCache();
  if (cache && now - Date.parse(cache.checkedAt) < DAY) return cache.latest;
  const latest = (await fetchLatest()) ?? cache?.latest;
  try {
    mkdirSync(bitlHome(), { recursive: true });
    writeFileSync(cachePath(), JSON.stringify({ checkedAt: new Date(now).toISOString(), latest } satisfies Cache) + '\n');
  } catch {
    // 다음에 다시
  }
  return latest;
}

/** 새 버전이 있으면 안내 문구, 없거나 확인할 수 없으면 undefined */
export async function updateNotice(current = process.env.BITL_CLIENT_VERSION): Promise<string | undefined> {
  if (!current || process.env.BITL_NO_UPDATE_CHECK === '1') return undefined;
  const latest = await latestVersion();
  if (!latest || compareVersions(latest, current) <= 0) return undefined;
  return `${t('update.available', { latest, current })}\n${t('update.changelog')}`;
}
