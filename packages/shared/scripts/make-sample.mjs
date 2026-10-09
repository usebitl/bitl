#!/usr/bin/env node
// 개인 덤프(~/.bitl/dumps)에서 이벤트 종류별 대표 1건씩 골라 익명화한 샘플 fixture 를 만든다.
//
//   node scripts/make-sample.mjs [dump.jsonl ...]
//
// - 입력을 안 주면 $BITL_DUMP_DIR 또는 ~/.bitl/dumps/*.jsonl 전체를 읽는다.
// - 출력: test/fixtures/<source>-sample.jsonl
// - 기존 샘플은 유지하고, 아직 없는 종류만 추가한다 (한 번 잡힌 희귀 이벤트를 잃지 않도록).
// - 구조(키, 타입)는 보존하고 값은 익명화한다: 문자열 → "<키이름>", id → 순번, 경로 → 가짜 경로.

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures');

// 값 자체가 형식 정보라 그대로 둬도 되는 키 (enum 성격, 개인정보 아님)
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
    if (typeof value !== 'string') return value; // 숫자·불리언·null 은 형식 정보로 유지
    if (KEEP.has(key)) return value;
    if (ID_KEY.test(key)) return idFor(key, value);
    if (PATH_KEY.test(key)) return `C:/work/project/<${key}>`;
    return `<${key || 'value'}>`;
  };
  return walk;
}

/** 같은 "종류"로 볼 기준. 도구 이벤트는 도구별, 알림은 알림 종류별로 따로 남긴다. */
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
  console.error('덤프 파일이 없습니다.');
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
    const anon = anonymizer(); // 레코드마다 id 순번을 새로 매겨 샘플끼리 연결되지 않게 한다
    added.push({
      receivedAt: '2026-01-01T00:00:00.000Z',
      source: rec.source,
      event: rec.event,
      payload: anon(rec.payload),
    });
  }
  const all = [...existing, ...added].sort((a, b) => kindOf(a).localeCompare(kindOf(b)));
  writeFileSync(out, all.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  console.log(`${out}: 기존 ${existing.length}건 + 추가 ${added.length}건`);
  for (const r of added) console.log(`  + ${kindOf(r)}`);
}
