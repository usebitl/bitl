import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { compareVersions, VERSION_PATTERN } from '@bitl/shared';
import { bitlHome } from '@bitl/shared/node';
import { t } from './i18n.js';

/**
 * New-version notice: one line after a command the user typed (status, install, login …).
 * - npm package only (repo runs have no version). Never called from hook/adapter paths — must not slow the agent
 * - Queries the npm registry at most once a day and skips if there is no answer within 1 second. Result is kept in $BITL_HOME/update-check.json
 * - Disabled by BITL_NO_UPDATE_CHECK=1
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

/** Latest version (checked once a day). Falls back to the last known value if the check fails */
async function latestVersion(now = Date.now()): Promise<string | undefined> {
  const cache = readCache();
  if (cache && now - Date.parse(cache.checkedAt) < DAY) return cache.latest;
  const latest = (await fetchLatest()) ?? cache?.latest;
  try {
    mkdirSync(bitlHome(), { recursive: true });
    writeFileSync(cachePath(), JSON.stringify({ checkedAt: new Date(now).toISOString(), latest } satisfies Cache) + '\n');
  } catch {
    // try again next time
  }
  return latest;
}

/** Notice text if a new version exists, undefined if none or unknown */
export async function updateNotice(current = process.env.BITL_CLIENT_VERSION): Promise<string | undefined> {
  if (!current || process.env.BITL_NO_UPDATE_CHECK === '1') return undefined;
  const latest = await latestVersion();
  if (!latest || compareVersions(latest, current) <= 0) return undefined;
  return `${t('update.available', { latest, current })}\n${t('update.changelog')}`;
}
