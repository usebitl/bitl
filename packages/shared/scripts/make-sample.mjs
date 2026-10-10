#!/usr/bin/env node
// Builds anonymized sample fixtures from personal dumps (~/.bitl/dumps), one representative per event kind.
//
//   node scripts/make-sample.mjs [dump.jsonl ...]
//
// - With no input, reads all of $BITL_DUMP_DIR or ~/.bitl/dumps/*.jsonl.
// - Output: test/fixtures/<source>-sample.jsonl
// - Keeps existing samples and only adds missing kinds (so rare events, once captured, are not lost).
// - Keeps structure (keys, types) and anonymizes values: string → "<keyName>", id → sequence number, path → fake path.

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures');

// Keys whose values are format info and safe to keep (enum-like, not personal data)
const KEEP = new Set([
  'hook_event_name', 'type', 'notification_type', 'permission_mode', 'effort', 'source', 'reason',
  'tool_name', 'agent_type', 'model', 'level', 'error_type', 'compaction_type', 'trigger', 'change_type',
]);
const ID_KEY = /(^|_)id$|-id$/;
const PATH_KEY = /(path|dir|cwd)$/i;

function anonymizer() {
  const ids = new Map();
  const idFor = (key, value) => {
    if (!ids.has(value)) ids.set(value, `${key.replace(/_?id$|-id$/, '') || 'id'}-${ids.size + 1}`);
    return ids.get(value);
  };
  const walk = (value, key = '') => {
    if (Array.isArray(value)) return value.map((v) => walk(v, key));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v, k)]));
    }
    if (typeof value !== 'string') return value; // keep numbers, booleans and null as format info
    if (KEEP.has(key)) return value;
    if (ID_KEY.test(key)) return idFor(key, value);
    if (PATH_KEY.test(key)) return `C:/work/project/<${key}>`;
    return `<${key || 'value'}>`;
  };
  return walk;
}

/** What counts as the same "kind". Tool events are kept per tool, notifications per notification type. */
function kindOf(rec) {
  const p = rec.payload ?? {};
  const sub = p.notification_type ?? p.tool_name ?? p.source ?? p.reason ?? p.agent_type ?? '';
  return `${rec.source}|${rec.event}|${sub}`;
}

function readJsonl(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

const inputs = process.argv.slice(2);
if (inputs.length === 0) {
  const dir = process.env.BITL_DUMP_DIR ?? join(homedir(), '.bitl', 'dumps');
  if (existsSync(dir)) {
    inputs.push(...readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => join(dir, f)));
  }
}
if (inputs.length === 0) {
  console.error('No dump files found.');
  process.exit(1);
}

const bySource = new Map();
for (const rec of inputs.flatMap(readJsonl)) {
  if (!bySource.has(rec.source)) bySource.set(rec.source, []);
  bySource.get(rec.source).push(rec);
}

for (const [source, records] of bySource) {
  const out = join(FIXTURES, `${source}-sample.jsonl`);
  const existing = readJsonl(out);
  const seen = new Set(existing.map(kindOf));
  const added = [];
  for (const rec of records) {
    const kind = kindOf(rec);
    if (seen.has(kind)) continue;
    seen.add(kind);
    const anon = anonymizer(); // renumber ids per record so samples cannot be linked to each other
    added.push({
      receivedAt: '2026-01-01T00:00:00.000Z',
      source: rec.source,
      event: rec.event,
      payload: anon(rec.payload),
    });
  }
  const all = [...existing, ...added].sort((a, b) => kindOf(a).localeCompare(kindOf(b)));
  writeFileSync(out, all.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  console.log(`${out}: ${existing.length} existing + ${added.length} added`);
  for (const r of added) console.log(`  + ${kindOf(r)}`);
}
