import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CLI_LATEST, cliStatus, compareVersions } from '../src/release.js';

describe('CLI version', () => {
  it('matches the npm package version (bump both when publishing)', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../cli/npm/package.json', import.meta.url), 'utf8')) as { version: string };
    expect(CLI_LATEST).toBe(pkg.version);
  });

  it('compares numerically', () => {
    expect(compareVersions('0.1.10', '0.1.9')).toBe(1);
    expect(compareVersions('0.1.4', '0.1.4')).toBe(0);
    expect(compareVersions('0.1.3', '0.2.0')).toBe(-1);
  });

  it('status', () => {
    expect(cliStatus(undefined)).toBe('unknown');
    expect(cliStatus('garbage')).toBe('unknown');
    expect(cliStatus('0.0.1')).toBe('update');
    expect(cliStatus(CLI_LATEST)).toBe('latest');
    expect(cliStatus('9.9.9')).toBe('latest');
  });
});
