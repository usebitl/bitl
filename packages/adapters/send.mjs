// Shared by bitl-hook.mjs and bitl-mcp.mjs: normalizes, minimizes and encrypts the raw payload and sends it; on failure, appends to queue.jsonl.
// Destination: the cloud account (device API key) if linked via bitl login, otherwise the local server on this PC.
// Only signals (for status detection) and ciphertext reach the server.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOME = process.env.BITL_HOME?.trim() || join(homedir(), '.bitl');
const POST_TIMEOUT_MS = 1500;
const MAX_QUEUE_BYTES = 20 * 1024 * 1024; // don't fill the disk even if the server stays unreachable for long
const MAX_ERROR_LOG_BYTES = 1024 * 1024;
const FLUSH_LIMIT = 500; // max lines to resend at once (so the hook isn't held up for long)
const QUEUE = join(HOME, 'queue.jsonl');

// normalization/encryption logic is a bundle of shared (TypeScript) (built by pnpm install / pnpm build)
let core;
const loadCore = () => (core ??= import('./dist/core.mjs'));

/** Never write to the agent's screen — problems are logged only here */
function logError(err) {
  try {
    const file = join(HOME, 'adapter-error.log');
    try {
      if (statSync(file).size > MAX_ERROR_LOG_BYTES) return;
    } catch {
      // no file
    }
    mkdirSync(HOME, { recursive: true });
    appendFileSync(file, `${new Date().toISOString()} ${err?.stack ?? err}\n`, 'utf8');
  } catch {
    // if even logging fails, move on quietly
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
    if (res.status === 401) logError(`${target.url}: 401 — this PC is no longer linked. Run bitl login to reconnect`);
    return res.ok;
  } catch {
    return false; // server down / network / timeout
  }
}

function enqueue(lines) {
  try {
    if (statSync(QUEUE).size > MAX_QUEUE_BYTES) return false;
  } catch {
    // no queue file
  }
  mkdirSync(HOME, { recursive: true });
  appendFileSync(QUEUE, lines.map((l) => l + '\n').join(''), 'utf8');
  return true;
}

/** Whether the record is sealed with this key (anything queued before the link changed is not sent to the new account) */
function sealedWith(line, kid) {
  try {
    return Object.values(JSON.parse(line).content ?? {}).every((v) => typeof v === 'string' && v.startsWith(`v1.${kid}.`));
  } catch {
    return false;
  }
}

/**
 * After a successful send to the cloud, also send queued events (in local mode the local server reads the queue on start).
 * Move the file first so other hooks don't overlap, and re-queue lines that couldn't be sent.
 */
async function flushQueue(target, kid) {
  if (!existsSync(QUEUE)) return;
  const processing = `${QUEUE}.${process.pid}.flushing`;
  try {
    renameSync(QUEUE, processing);
  } catch {
    return; // another hook took it first
  }
  const lines = readFileSync(processing, 'utf8').split('\n').filter(Boolean);
  unlinkSync(processing);
  const later = [];
  let failed = false;
  for (const [i, line] of lines.entries()) {
    if (!sealedWith(line, kid)) continue; // sealed with another key or old format — drop it
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
    logError(err); // no bundle (not built yet) or key unreadable
    return 'dropped';
  }
  if (!prepared.record) return 'dropped'; // unparseable event
  const body = JSON.stringify(prepared.record);
  if (await post(prepared, body)) {
    if (prepared.kind === 'cloud') await flushQueue(prepared, prepared.kid).catch(logError);
    return 'sent';
  }
  return enqueue([body]) ? 'queued' : 'dropped';
}
