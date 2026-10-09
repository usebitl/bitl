// 원격 승인: PC 의 Claude Code 가 권한을 물으면 폰에서 허용·거부한다.
//
// 서버는 중계만 하고, 승인을 만들어 낼 수 없어야 한다 — 서버가 털려도 PC 에서 명령이 실행되면 안 된다.
//   - 요청 내용(도구·명령)은 PC 가 계정 키로 봉인한다. AAD = 승인 id → 서버가 다른 요청의 내용으로 바꿔 보여줄 수 없다
//   - 결정(allow/deny)은 폰이 계정 키에서 따로 만든 승인 키로 서명한다 (HMAC, 승인 id 포함) → 서버는 서명을 만들 수 없다
//   - PC 는 서명을 확인한 결정만 따른다. 확인이 안 되면 터미널의 승인 창으로 넘긴다
// 승인 id 는 PC 가 요청마다 새로 만든다 — 지난 승인의 서명을 다른 요청에 다시 쓸 수 없다.
import { type ContentKeys, fromBase64Url, open, seal, toBase64Url, type Sealed } from './crypto.js';
import { oneLine, summarizeToolInput } from './normalize.js';

export type ApprovalDecision = 'allow' | 'deny';
export const APPROVAL_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
export const APPROVAL_SIG_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** 폰에 보여줄 승인 요청 (봉인되어 서버를 지난다) */
export interface ApprovalRequest {
  tool: string;
  /** 한 줄 요약 — 알림·카드용 (예: "Bash: rm -rf dist") */
  summary: string;
  /** 자세히 — 전체 명령, 바꿀 파일과 내용 일부 등 */
  detail?: string;
  /** 에이전트가 붙인 설명 (Bash 의 description 등) */
  description?: string;
  project?: string;
  cwd?: string;
}

const MAX_DETAIL = 4000;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const str = (v: unknown) => (typeof v === 'string' && v.length > 0 ? v : undefined);

export function newApprovalId(): string {
  return toBase64Url(globalThis.crypto.getRandomValues(new Uint8Array(16)));
}

/** Claude Code PermissionRequest 의 tool_name·tool_input → 폰에 보여줄 요청 */
export function describeToolRequest(toolName: string, input: unknown, extra: { project?: string; cwd?: string } = {}): ApprovalRequest {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const short = summarizeToolInput(i);
  let detail: string | undefined;
  if (typeof i.command === 'string') detail = i.command;
  else if (typeof i.file_path === 'string') {
    // Write: content, Edit: old_string → new_string, MultiEdit: edits
    const body =
      str(i.content) ??
      (typeof i.new_string === 'string' ? `- ${oneLine(String(i.old_string ?? ''), 300)}\n+ ${i.new_string}` : undefined) ??
      (Array.isArray(i.edits) ? `${i.edits.length}곳 수정` : undefined);
    detail = body ? `${i.file_path}\n\n${body}` : i.file_path;
  } else if (typeof i.plan === 'string') detail = i.plan;
  else if (Object.keys(i).length) detail = JSON.stringify(i, null, 2);
  return {
    tool: toolName,
    summary: oneLine(short ? `${toolName}: ${short}` : toolName, 200),
    detail: detail ? clip(detail, MAX_DETAIL) : undefined,
    description: str(i.description) ? oneLine(String(i.description), 300) : undefined,
    ...extra,
  };
}

const aad = (id: string) => `approval:${id}`;

export const sealApprovalRequest = (keys: ContentKeys, id: string, req: ApprovalRequest): Promise<Sealed> => seal(keys, JSON.stringify(req), aad(id));

export async function openApprovalRequest(keys: ContentKeys, id: string, sealed: Sealed): Promise<ApprovalRequest> {
  const req = JSON.parse(await open(keys, sealed, aad(id))) as ApprovalRequest;
  if (typeof req?.tool !== 'string' || typeof req.summary !== 'string') throw new Error('invalid approval request');
  return req;
}

// 승인 서명 키: 계정 키(마스터)에서 용도를 분리해 만든다. 다른 HMAC(tag) 과 섞이지 않게
const approvalKeys = new WeakMap<ContentKeys, Promise<CryptoKey>>();
function approvalKey(keys: ContentKeys): Promise<CryptoKey> {
  let k = approvalKeys.get(keys);
  if (!k) {
    k = globalThis.crypto.subtle
      .importKey('raw', keys.master, 'HKDF', false, ['deriveKey'])
      .then((base) =>
        globalThis.crypto.subtle.deriveKey(
          { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode('bitl/v1/approve') },
          base,
          { name: 'HMAC', hash: 'SHA-256', length: 256 },
          false,
          ['sign', 'verify'],
        ),
      );
    approvalKeys.set(keys, k);
  }
  return k;
}

const message = (id: string, decision: ApprovalDecision) => new TextEncoder().encode(`bitl/approval/v1\n${id}\n${decision}`);

/** 폰(브라우저): 결정에 서명한다 */
export async function signDecision(keys: ContentKeys, id: string, decision: ApprovalDecision): Promise<string> {
  const mac = await globalThis.crypto.subtle.sign('HMAC', await approvalKey(keys), message(id, decision));
  return toBase64Url(new Uint8Array(mac));
}

/** PC(hook): 이 계정 키로 서명한 결정인지 확인한다 (상수 시간 비교) */
export async function verifyDecision(keys: ContentKeys, id: string, decision: string, sig: string): Promise<boolean> {
  if ((decision !== 'allow' && decision !== 'deny') || !APPROVAL_SIG_PATTERN.test(sig)) return false;
  return globalThis.crypto.subtle.verify('HMAC', await approvalKey(keys), fromBase64Url(sig), message(id, decision));
}
