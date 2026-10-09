// 원격 승인 — PC 쪽 (Claude Code PermissionRequest hook: adapters/bitl-approve.mjs).
//
// 원격 승인이 켜졌을 때만: 요청을 봉인해 올리고, 폰의 결정을 기다렸다가 서명을 확인해 allow/deny 를 돌려준다.
// 그 밖의 경우(원격 승인 꺼짐, 서버 연결 실패, 시간 초과, 서명이 틀림)는 null → hook 이 아무것도 출력하지 않고
// Claude Code 가 평소처럼 터미널에 승인 창을 띄운다. 어떤 실패도 "허용"으로 이어지지 않는다.
import { describeToolRequest, newApprovalId, sealApprovalRequest, verifyDecision } from '../approval.js';
import { resolveTarget } from './cloud.js';
import { projectName } from './enrich.js';
import { bitlHome } from './keys.js';

export type RemoteDecision = { behavior: 'allow' } | { behavior: 'deny'; message: string };

export interface ApproveOptions {
  home?: string;
  /** 폰의 답을 기다릴 최대 시간 */
  waitMs?: number;
  /** hook 이 끝나야 할 때 (Claude Code 가 hook 을 멈춤) */
  signal?: AbortSignal;
  log?: (msg: string) => void;
}

/** 기본 대기 10분. hook 설정의 timeout 은 이보다 길게 (cli/install.ts) */
export const DEFAULT_APPROVAL_WAIT_MS = 10 * 60_000;
/** 폰이 답하지 않아도 되는 도구: 선택지 질문은 hook 으로 답할 수 없다 (터미널에서만) */
const SKIP_TOOLS = new Set(['AskUserQuestion']);
const POLL_MS = 25_000;
const DENY_MESSAGE = '사용자가 휴대폰(BITL 원격 승인)에서 거부했습니다.';

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

  // 1. 원격 승인이 켜졌나 — 아니면 바로 물러난다 (터미널 창이 늦게 뜨지 않게 짧게)
  try {
    if ((await api('/api/approvals/mode', { timeoutMs: 2000 })).away !== true) return null;
  } catch (err) {
    log(`원격 승인: 서버에 물을 수 없어 터미널에서 승인합니다 (${(err as Error).message})`);
    return null;
  }

  // 2. 요청을 봉인해 올린다
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
    log(`원격 승인: 요청을 올리지 못했습니다 (${(err as Error).message})`);
    return null;
  }

  // 3. 결정을 기다린다
  const deadline = Date.now() + waitMs;
  // hook 이 멈춰도(Claude Code 가 끝냄) 폰에 남지 않게 알린다
  const cancel = () => api(`/api/approvals/${id}/cancel`, { method: 'POST', timeoutMs: 3000, keepOnAbort: true }).catch(() => undefined);
  while (Date.now() < deadline && !opts.signal?.aborted) {
    let a: Record<string, unknown>;
    try {
      const ms = Math.min(POLL_MS, Math.max(deadline - Date.now(), 0));
      a = await api(`/api/approvals/${id}/wait?ms=${ms}`, { timeoutMs: ms + 10_000 });
    } catch {
      await sleep(2000, opts.signal); // 네트워크가 잠깐 끊김 — 다시 묻는다
      continue;
    }
    const status = a.status;
    if (status === 'pending') continue;
    if (status === 'allow' || status === 'deny') {
      // 서버가 보낸 결정을 믿지 않는다: 계정 키로 서명했는지 확인
      if (!(await verifyDecision(keys, id, status, typeof a.sig === 'string' ? a.sig : ''))) {
        log(`원격 승인: 서명이 맞지 않는 결정을 받았습니다 (${id}) — 따르지 않고 터미널에서 승인합니다`);
        return null;
      }
      return status === 'allow' ? { behavior: 'allow' } : { behavior: 'deny', message: DENY_MESSAGE };
    }
    return null; // cancelled · expired
  }
  await cancel();
  return null;
}
