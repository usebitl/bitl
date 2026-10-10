// Remote approval — PC side (Claude Code PermissionRequest hook: adapters/bitl-approve.mjs).
//
// Only when remote approval is on: seals and uploads the request, waits for the phone's decision, verifies the signature and returns allow/deny.
// In every other case (remote approval off, server unreachable, timeout, bad signature) it returns null → the hook prints nothing and
// Claude Code shows the approval prompt in the terminal as usual. No failure ever turns into "allow".
import { describeToolRequest, newApprovalId, sealApprovalRequest, verifyDecision } from '../approval.js';
import { resolveTarget } from './cloud.js';
import { projectName } from './enrich.js';
import { bitlHome } from './keys.js';

export type RemoteDecision = { behavior: 'allow' } | { behavior: 'deny'; message: string };

export interface ApproveOptions {
  home?: string;
  /** Max time to wait for the phone's answer */
  waitMs?: number;
  /** When the hook must end (Claude Code stops the hook) */
  signal?: AbortSignal;
  log?: (msg: string) => void;
}

/** Default wait is 10 minutes. The hook config timeout is longer than this (cli/install.ts) */
export const DEFAULT_APPROVAL_WAIT_MS = 10 * 60_000;
/** Tools the phone doesn't answer: multiple-choice questions can't be answered via the hook (terminal only) */
const SKIP_TOOLS = new Set(['AskUserQuestion']);
const POLL_MS = 25_000;
const DENY_MESSAGE = 'The user denied this from their phone (BITL remote approval).';

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
  });

export async function requestRemoteApproval(payload: Record<string, unknown>, opts: ApproveOptions = {}): Promise<RemoteDecision | null> {
  const log = opts.log ?? (() => {});
  const tool = typeof payload.tool_name === 'string' ? payload.tool_name : undefined;
  const sessionId = typeof payload.session_id === 'string' ? payload.session_id : undefined;
  if (!tool || !sessionId || SKIP_TOOLS.has(tool)) return null;

  const target = resolveTarget(opts.home ?? bitlHome());
  const api = async (path: string, init: RequestInit & { timeoutMs: number; keepOnAbort?: boolean }) => {
    const signals = [AbortSignal.timeout(init.timeoutMs), ...(opts.signal && !init.keepOnAbort ? [opts.signal] : [])];
    const res = await fetch(`${target.url}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...target.headers },
      signal: AbortSignal.any(signals),
    });
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  };

  // 1. Is remote approval on? If not, back off right away (short, so the terminal prompt isn't delayed)
  try {
    if ((await api('/api/approvals/mode', { timeoutMs: 2000 })).away !== true) return null;
  } catch (err) {
    log(`remote approval: can't reach the server, approving in the terminal (${(err as Error).message})`);
    return null;
  }

  // 2. Seal and upload the request
  const keys = await target.keys();
  const id = newApprovalId();
  const cwd = typeof payload.cwd === 'string' ? payload.cwd : undefined;
  const project = cwd ? await projectName(cwd).catch(() => undefined) : undefined;
  const request = await sealApprovalRequest(keys, id, describeToolRequest(tool, payload.tool_input, { project, cwd }));
  const waitMs = opts.waitMs ?? DEFAULT_APPROVAL_WAIT_MS;
  const source = typeof payload.source === 'string' ? payload.source : 'claude-code';
  try {
    await api('/api/approvals', {
      method: 'POST',
      body: JSON.stringify({ id, sessionKey: `${source}:${sessionId}`, request, ttlSec: Math.ceil(waitMs / 1000) }),
      timeoutMs: 5000,
    });
  } catch (err) {
    log(`remote approval: failed to upload the request (${(err as Error).message})`);
    return null;
  }

  // 3. Wait for the decision
  const deadline = Date.now() + waitMs;
  // If the hook is stopped (Claude Code ended it), tell the server so it doesn't linger on the phone
  const cancel = () => api(`/api/approvals/${id}/cancel`, { method: 'POST', timeoutMs: 3000, keepOnAbort: true }).catch(() => undefined);
  while (Date.now() < deadline && !opts.signal?.aborted) {
    let a: Record<string, unknown>;
    try {
      const ms = Math.min(POLL_MS, Math.max(deadline - Date.now(), 0));
      a = await api(`/api/approvals/${id}/wait?ms=${ms}`, { timeoutMs: ms + 10_000 });
    } catch {
      await sleep(2000, opts.signal); // brief network drop — ask again
      continue;
    }
    const status = a.status;
    if (status === 'pending') continue;
    if (status === 'allow' || status === 'deny') {
      // Don't trust the decision the server sent: verify it was signed with the account key
      if (!(await verifyDecision(keys, id, status, typeof a.sig === 'string' ? a.sig : ''))) {
        log(`remote approval: received a decision with an invalid signature (${id}) — ignoring it and approving in the terminal`);
        return null;
      }
      return status === 'allow' ? { behavior: 'allow' } : { behavior: 'deny', message: DENY_MESSAGE };
    }
    return null; // cancelled · expired
  }
  await cancel();
  return null;
}
