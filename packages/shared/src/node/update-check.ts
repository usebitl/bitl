import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { compareVersions, VERSION_PATTERN } from '../release.js';
import { bitlHome } from './keys.js';

/**
 * New-version check for the npm package (@usebitl/cli), shared by the CLI notice and the local server's board banner.
 * - Only when running from the npm package (BITL_CLIENT_VERSION is injected at build; repo runs have no version)
 * - Asks the npm registry for the latest version at most once a day, gives up after 1 second. Cached in $BITL_HOME/update-check.json
 * - Sends nothing but that GET. Disabled by BITL_NO_UPDATE_CHECK=1
 * Never call this from hook/adapter paths — it must not slow the agent.
 */
const REGISTRY = 'https://registry.npmjs.org/@usebitl/cli/latest';
const DAY = 86_400_000;
const TIMEOUT_MS = 1000;

interface Cache {
  checkedAt: string;
  latest?: string;
}

export interface CliUpdate {
  current: string;
  latest: string;
  /** Command to update with, matching how this bitl was installed */
  command: string;
}

const cachePath = (home: string) => join(home, 'update-check.json');

function readCache(home: string): Cache | null {
  try {
    return JSON.parse(readFileSync(cachePath(home), 'utf8')) as Cache;
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
async function latestVersion(home: string, now: number): Promise<string | undefined> {
  const cache = readCache(home);
  if (cache && now - Date.parse(cache.checkedAt) < DAY) return cache.latest;
  const latest = (await fetchLatest()) ?? cache?.latest;
  try {
    mkdirSync(home, { recursive: true });
    writeFileSync(cachePath(home), JSON.stringify({ checkedAt: new Date(now).toISOString(), latest } satisfies Cache) + '\n');
  } catch {
    // try again next time
  }
  return latest;
}

/** bin/bitl.mjs sets BITL_INSTALL=npx when it runs from the npx cache */
export const updateCommand = (install = process.env.BITL_INSTALL): string =>
  install === 'npx' ? 'npx @usebitl/cli@latest start' : 'npm i -g @usebitl/cli';

/** The update if a newer version exists; undefined if up to date, unknown or disabled */
export async function checkCliUpdate(
  current = process.env.BITL_CLIENT_VERSION,
  opts: { home?: string; now?: number } = {},
): Promise<CliUpdate | undefined> {
  if (!current || process.env.BITL_NO_UPDATE_CHECK === '1') return undefined;
  const latest = await latestVersion(opts.home ?? bitlHome(), opts.now ?? Date.now());
  if (!latest || compareVersions(latest, current) <= 0) return undefined;
  return { current, latest, command: updateCommand() };
}
