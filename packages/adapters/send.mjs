// bitl-hook.mjs · bitl-mcp.mjs 공용: 원본을 정규화·최소화·암호화해 보내고, 실패하면 queue.jsonl 에 쌓는다.
// 보낼 곳: bitl login 으로 클라우드 계정에 연결했으면 그 계정(기기 API 키), 아니면 이 PC 의 로컬 서버.
// 서버에는 신호(상태 판단용)와 암호문만 간다.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOME = process.env.BITL_HOME?.trim() || join(homedir(), '.bitl');
const POST_TIMEOUT_MS = 1500;
const MAX_QUEUE_BYTES = 20 * 1024 * 1024; // 서버를 오래 못 만나도 디스크를 채우지 않도록
const MAX_ERROR_LOG_BYTES = 1024 * 1024;
const FLUSH_LIMIT = 500; // 한 번에 다시 보낼 최대 줄 수 (hook 을 오래 붙잡지 않게)
const QUEUE = join(HOME, 'queue.jsonl');

// 정규화·암호화 로직은 shared(TypeScript)를 묶은 번들 (pnpm install / pnpm build 가 만든다)
let core;
const loadCore = () => (core ??= import('./dist/core.mjs'));

/** 에이전트 화면에는 아무것도 쓰지 않는다 — 문제는 여기에만 남긴다 */
function logError(err) {
  try {
    const file = join(HOME, 'adapter-error.log');
    try {
      if (statSync(file).size > MAX_ERROR_LOG_BYTES) return;
    } catch {
      // 파일 없음
    }
    mkdirSync(HOME, { recursive: true });
    appendFileSync(file, `${new Date().toISOString()} ${err?.stack ?? err}\n`, 'utf8');
  } catch {
    // 기록도 못 하면 조용히 넘어간다
  }
}

async function post(target, body) {
  try {
    const res = await fetch(`${target.url}/api/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...target.headers },
      body,
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    });
    if (res.status === 401) logError(`${target.url}: 401 — 이 PC 의 연결이 끊겼습니다. bitl login 으로 다시 연결하세요`);
    return res.ok;
  } catch {
    return false; // 서버 꺼짐 / 네트워크 / 타임아웃
  }
}

function enqueue(lines) {
  try {
    if (statSync(QUEUE).size > MAX_QUEUE_BYTES) return false;
  } catch {
    // 큐 파일 없음
  }
  mkdirSync(HOME, { recursive: true });
  appendFileSync(QUEUE, lines.map((l) => l + '\n').join(''), 'utf8');
  return true;
}

/** 이 키로 봉인된 레코드인지 (연결을 바꾸기 전에 쌓인 것은 새 계정으로 보내지 않는다) */
function sealedWith(line, kid) {
  try {
    return Object.values(JSON.parse(line).content ?? {}).every((v) => typeof v === 'string' && v.startsWith(`v1.${kid}.`));
  } catch {
    return false;
  }
}

/**
 * 클라우드로 보냈으면 쌓아 둔 이벤트도 보낸다 (로컬 모드는 로컬 서버가 시작할 때 큐를 읽는다).
 * 다른 hook 과 겹치지 않게 파일을 먼저 옮기고, 못 보낸 줄은 다시 쌓는다.
 */
async function flushQueue(target, kid) {
  if (!existsSync(QUEUE)) return;
  const processing = `${QUEUE}.${process.pid}.flushing`;
  try {
    renameSync(QUEUE, processing);
  } catch {
    return; // 다른 hook 이 먼저 가져감
  }
  const lines = readFileSync(processing, 'utf8').split('\n').filter(Boolean);
  unlinkSync(processing);
  const later = [];
  let failed = false;
  for (const [i, line] of lines.entries()) {
    if (!sealedWith(line, kid)) continue; // 다른 키로 봉인됐거나 옛 형식 — 버린다
    if (failed || i >= FLUSH_LIMIT || !(await post(target, line))) {
      failed = true;
      later.push(line);
    }
  }
  if (later.length) enqueue(later);
}

/** @returns {Promise<'sent' | 'queued' | 'dropped'>} */
export async function sendRecord({ source, receivedAt = new Date().toISOString(), payload }) {
  let prepared;
  try {
    prepared = await (await loadCore()).prepareForTarget({ source, receivedAt, payload }, HOME);
  } catch (err) {
    logError(err); // 번들이 없거나(빌드 전) 키를 못 읽음
    return 'dropped';
  }
  if (!prepared.record) return 'dropped'; // 해석할 수 없는 이벤트
  const body = JSON.stringify(prepared.record);
  if (await post(prepared, body)) {
    if (prepared.kind === 'cloud') await flushQueue(prepared, prepared.kid).catch(logError);
    return 'sent';
  }
  return enqueue([body]) ? 'queued' : 'dropped';
}
