#!/usr/bin/env node
// Entry point for the bitl command (npm package @usebitl/cli).
// Copies the adapters that hooks run into ~/.bitl/adapters (only when the version changed) and runs the CLI with that path.
// The global npm folder changes with the Node version (nvm etc.), so hooks pointing at it directly can silently break.
//   node bin/bitl.mjs __sync  — copy only (npm postinstall). A failure does not block the install
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const syncOnly = process.argv[2] === '__sync';
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const home = process.env.BITL_HOME?.trim() || join(homedir(), '.bitl');
const dir = join(home, 'adapters');
const stamp = join(dir, '.version');

try {
  if (!existsSync(stamp) || readFileSync(stamp, 'utf8').trim() !== version) {
    mkdirSync(dir, { recursive: true });
    cpSync(new URL('../adapters/', import.meta.url), dir, { recursive: true, force: true });
    writeFileSync(stamp, version);
  }
} catch (err) {
  if (syncOnly) process.exit(0);
  console.error(`bitl: could not copy adapters to ${dir} — ${err?.message ?? err}`);
  process.exit(1);
}
if (syncOnly) process.exit(0);

process.env.BITL_ADAPTER_DIR = dir;
// Web UI that bitl start serves (built into the package)
process.env.BITL_WEB_DIST ??= fileURLToPath(new URL('../web/', import.meta.url));
await import('../dist/cli.mjs');
