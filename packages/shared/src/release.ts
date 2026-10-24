// bitl CLI (@usebitl/cli) version published to npm — the web devices screen uses it to tell whether bitl on a work PC is outdated.
// Bump and deploy only after npm publish finishes (bumping first would tell users to update to a version that doesn't exist yet).
// Must match the version in cli/npm/package.json — checked by test/release.test.ts.

/** Current latest version on npm */
export const CLI_LATEST = '0.1.25';

/**
 * Mandatory update version (server format change, security issue). If any PC is below `below`, a notice is shown at the top of the screen.
 * from: from that date old versions can no longer send tasks (YYYY-MM-DD). Normally undefined.
 */
export const CLI_REQUIRED: { below: string; from: string } | undefined = undefined;

/** "0.1.10" > "0.1.9". Malformed parts count as 0 instead of NaN */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}

export const VERSION_PATTERN = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;

/** bitl status on a work PC: latest · update available · update required · unknown (0.1.3 and earlier don't report their version) */
export type CliStatus = 'latest' | 'update' | 'required' | 'unknown';

export function cliStatus(version: string | undefined): CliStatus {
  if (!version || !VERSION_PATTERN.test(version)) return 'unknown';
  if (CLI_REQUIRED && compareVersions(version, CLI_REQUIRED.below) < 0) return 'required';
  return compareVersions(version, CLI_LATEST) < 0 ? 'update' : 'latest';
}
