// Remote approval: when Claude Code on the PC asks for permission, allow or deny it from the phone.
//
// The server only relays and must not be able to forge an approval — even if the server is compromised, no command may run on the PC.
//   - The request content (tool/command) is sealed by the PC with the account key. AAD = approval id → the server can't swap in another request's content
//   - The decision (allow/deny) is signed by the phone with a separate approval key derived from the account key (HMAC, includes the approval id) → the server can't produce a signature
//   - The PC only follows decisions whose signature checks out. Otherwise it falls back to the terminal's approval prompt
// The PC creates a new approval id per request — a past approval's signature can't be reused for another request.
import { type ContentKeys, fromBase64Url, open, seal, toBase64Url, type Sealed } from './crypto.js';
import { oneLine, summarizeToolInput } from './normalize.js';

export type ApprovalDecision = 'allow' | 'deny';
export const APPROVAL_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
export const APPROVAL_SIG_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** Approval request shown on the phone (passes through the server sealed) */
export interface ApprovalRequest {
  tool: string;
  /** One-line summary — for notifications/cards (e.g. "Bash: rm -rf dist") */
  summary: string;
  /** Details — full command, the file to change and part of its content, etc. */
  detail?: string;
  /** Description attached by the agent (Bash's description etc.) */
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

/** Claude Code PermissionRequest tool_name/tool_input → request shown on the phone */
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
      (Array.isArray(i.edits) ? `${i.edits.length} edits` : undefined);
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

// Approval signing key: derived from the account (master) key with a separate purpose, so it never mixes with the other HMAC (tag)
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

/** Phone (browser): signs the decision */
export async function signDecision(keys: ContentKeys, id: string, decision: ApprovalDecision): Promise<string> {
  const mac = await globalThis.crypto.subtle.sign('HMAC', await approvalKey(keys), message(id, decision));
  return toBase64Url(new Uint8Array(mac));
}

/** PC (hook): checks the decision was signed with this account key (constant-time comparison) */
export async function verifyDecision(keys: ContentKeys, id: string, decision: string, sig: string): Promise<boolean> {
  if ((decision !== 'allow' && decision !== 'deny') || !APPROVAL_SIG_PATTERN.test(sig)) return false;
  return globalThis.crypto.subtle.verify('HMAC', await approvalKey(keys), fromBase64Url(sig), message(id, decision));
}
