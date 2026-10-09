#!/usr/bin/env node
// BITL MCP 서버 (stdio). hook 이 없는 클라이언트(Claude Desktop 등)에서 에이전트가 스스로 작업 상태를 보고한다.
//
//   node bitl-mcp.mjs [--source claude-desktop]
//
// 의존성 없이 MCP(JSON-RPC 2.0, 줄 단위) 의 필요한 부분만 구현한다: initialize, tools/list, tools/call, ping.
// stdout 은 프로토콜 전용이므로 로그는 stderr 로만 쓴다.

import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { sendRecord } from './send.mjs';

const argValue = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const SOURCE = argValue('--source') ?? 'claude-desktop';
const DEFAULT_PROTOCOL = '2025-06-18';

// report_status 의 status → BITL 상태 보고 event
const STATUS_EVENT = {
  started: 'start',
  in_progress: 'progress',
  waiting_for_user: 'waiting',
  done: 'done',
  failed: 'error',
};

const INSTRUCTIONS = `이 서버는 사용자의 작업 현황판(BITL)에 진행 상황을 알린다. 사용자가 여러 작업을 병렬로 맡기며 무엇이 자신을 기다리는지 놓치지 않게 하는 것이 목적이다.
- 이 보고는 사용자에게 보이지 않으며 답변이 아니다.
- 사용자 메시지마다 (간단한 질문도 예외 없이): 마지막 답변을 쓰기 직전에 한 번 report_status("done" 또는 "waiting_for_user", request=그 메시지 원문, detail=곧 쓸 답의 한 문장 요약 — 첫 보고면 title 넣고 task_id 없이, 이어진 메시지면 같은 task_id) → 답변을 쓰고 끝낸다. 답 뒤에는 이 도구를 부르지 않는다
- 도구를 쓰는 긴 작업이면 시작할 때 "started"(request=원문)를 먼저. 실패하면 "failed".`;

const TOOLS = [
  {
    name: 'report_status',
    // Claude Desktop 채팅은 이 도구를 원격 도구 브리지로 받는데, 브리지는 서버 instructions 를 넘기지 않는다.
    // 그래서 호출 규칙을 도구 설명 자체에 담는다 (INSTRUCTIONS 와 같은 내용).
    description: `사용자의 작업 현황판(BITL)에 작업 상태를 보고한다. 사용자는 여러 작업을 병렬로 맡기며 이 현황판으로 무엇이 자신을 기다리는지 확인한다.
이 보고는 사용자에게 보이지 않으며 답변이 아니다. 사용자 메시지마다 (첫 메시지든 이어진 대화든, 간단한 질문도 예외 없이):
· 마지막 답변을 쓰기 직전에 한 번: status="done"(답을 마침) 또는 "waiting_for_user"(질문·확인 요청으로 끝냄),
  request=사용자 메시지 원문(요약·바꿔 쓰기 금지, 길면 앞부분만), detail=곧 쓸 답의 한 문장 요약.
  대화의 첫 보고면 title=주제를 담은 짧은 제목을 넣고 task_id 없이 → 돌려받은 task_id 를 이 대화 내내 기억한다. 이어진 메시지면 같은 task_id 를 넣는다.
· 그다음 답변을 대화에 쓰고 끝낸다. 답변을 쓴 뒤에는 이 도구를 부르지 않는다 (답 뒤에 부르면 답이 도구 묶음 안에 접혀 보이지 않는다).
· 웹 검색·파일 작업처럼 도구를 쓰는 긴 작업이면 시작할 때 status="started"(request=원문, 첫 보고면 title)를 먼저 보낸다 — 보드에 "실행 중"으로 보인다.
· 실패하면 "failed".`,
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: Object.keys(STATUS_EVENT), description: '작업 상태' },
        title: { type: 'string', description: '작업 제목 (대화의 첫 보고에 필수, 40자 이내 권장)' },
        request: { type: 'string', description: '이번 응답이 답한 사용자 메시지 원문 그대로 — 요약·바꿔 쓰기 금지 (길면 앞부분 2000자까지)' },
        detail: { type: 'string', description: '곧 쓸 답의 한 문장 요약, 현재 단계, 또는 사용자에게 필요한 것 (요청 내용은 request 에)' },
        task_id: { type: 'string', description: '대화의 첫 보고가 돌려준 id — 첫 보고 외에는 모두 넣는다' },
      },
      // request 를 필수로 두면 모델이 요청·응답을 detail 하나에 몰아 적지 않는다 (서버는 없어도 받는다)
      required: ['status', 'request'],
    },
  },
];

/** started 를 받고 아직 끝나지 않은 작업 (이 프로세스가 켜져 있는 동안) */
const running = new Set();

async function reportStatus(args) {
  const event = STATUS_EVENT[args?.status];
  if (!event) return { isError: true, text: `status 는 ${Object.keys(STATUS_EVENT).join(', ')} 중 하나여야 합니다.` };
  // task_id 없는 보고 = 대화의 첫 보고 → 새 카드 (title 필요). Claude Desktop 은 이 프로세스 하나를 모든 대화가 공유하므로 "마지막 작업"으로 추정하지 않는다
  if (!args.task_id && !args.title) return { isError: true, text: '대화의 첫 보고에는 title 이 필요합니다.' };
  const taskId = args.task_id || randomUUID();
  const send = (ev) => sendRecord({ source: SOURCE, payload: { session_id: taskId, event: ev, title: args.title, request: args.request, detail: args.detail } });
  // 짧은 채팅은 답변 직전 done 한 번만 온다 — 진행 중인 턴이 없으면 먼저 새 턴을 연다 (질문 원문이 그 턴에 남게)
  if (event === 'start') running.add(taskId);
  else if (event !== 'progress') {
    if (!running.has(taskId)) await send('start');
    running.delete(taskId);
  }
  const result = await send(event);
  const note = result === 'sent' ? '' : result === 'queued' ? ' (현황판 서버가 꺼져 있어 대기열에 저장함)' : ' (저장 실패)';
  // 결과에는 사실만: 도구 결과 속 지시문은 Claude 가 프롬프트 주입으로 경계해 답에서 벗어난다 (connector-api.ts 와 같음)
  return { text: `기록됨. task_id: ${taskId}${note}` };
}

const write = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const reply = (id, result) => write({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => write({ jsonrpc: '2.0', id, error: { code, message } });

async function handle(msg) {
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;
  switch (method) {
    case 'initialize':
      return reply(id, {
        protocolVersion: params?.protocolVersion ?? DEFAULT_PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name: 'bitl', version: '0.1.0' },
        instructions: INSTRUCTIONS,
      });
    case 'ping':
      return reply(id, {});
    case 'tools/list':
      return reply(id, { tools: TOOLS });
    case 'tools/call': {
      if (params?.name !== 'report_status') return fail(id, -32602, `unknown tool: ${params?.name}`);
      const { text, isError } = await reportStatus(params.arguments ?? {});
      return reply(id, { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) });
    }
    default:
      // notifications/* 등 응답이 필요 없는 메시지는 무시
      if (isRequest) fail(id, -32601, `method not found: ${method}`);
  }
}

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return fail(null, -32700, 'parse error');
  }
  handle(msg).catch((err) => {
    process.stderr.write(`bitl-mcp: ${err?.stack ?? err}\n`);
    if (msg.id !== undefined) fail(msg.id, -32603, 'internal error');
  });
});
