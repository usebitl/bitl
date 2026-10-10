#!/usr/bin/env node
// BITL MCP server (stdio). In clients without hooks (Claude Desktop etc.) the agent reports its own task status.
//
//   node bitl-mcp.mjs [--source claude-desktop]
//
// Implements only the needed parts of MCP (JSON-RPC 2.0, line-delimited) with no dependencies: initialize, tools/list, tools/call, ping.
// stdout is reserved for the protocol, so logs go to stderr only.

import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { sendRecord } from './send.mjs';

const argValue = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const SOURCE = argValue('--source') ?? 'claude-desktop';
const DEFAULT_PROTOCOL = '2025-06-18';

// report_status status → BITL status report event
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
    // Claude Desktop chat gets this tool through a remote tool bridge, which doesn't pass on the server instructions.
    // So the calling rules live in the tool description itself (same content as INSTRUCTIONS).
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
      // making request required keeps the model from cramming request and answer into detail (the server accepts it without)
      required: ['status', 'request'],
    },
  },
];

/** Tasks that got started and haven't finished yet (while this process is running) */
const running = new Set();

async function reportStatus(args) {
  const event = STATUS_EVENT[args?.status];
  if (!event) return { isError: true, text: `status 는 ${Object.keys(STATUS_EVENT).join(', ')} 중 하나여야 합니다.` };
  // a report without task_id = the conversation's first report → new card (title required). All Claude Desktop conversations share this one process, so don't guess "the last task"
  if (!args.task_id && !args.title) return { isError: true, text: '대화의 첫 보고에는 title 이 필요합니다.' };
  const taskId = args.task_id || randomUUID();
  const send = (ev) => sendRecord({ source: SOURCE, payload: { session_id: taskId, event: ev, title: args.title, request: args.request, detail: args.detail } });
  // a short chat sends only one done right before answering — if no turn is in progress, open a new one first (so the original question stays on that turn)
  if (event === 'start') running.add(taskId);
  else if (event !== 'progress') {
    if (!running.has(taskId)) await send('start');
    running.delete(taskId);
  }
  const result = await send(event);
  const note = result === 'sent' ? '' : result === 'queued' ? ' (현황판 서버가 꺼져 있어 대기열에 저장함)' : ' (저장 실패)';
  // facts only in the result: Claude treats instructions inside tool results as prompt injection and drifts off its answer (same as connector-api.ts)
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
      // ignore messages that need no response, like notifications/*
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
