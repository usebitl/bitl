<p align="center">
  <img src="packages/web/public/icon-192.png" width="72" alt="BITL">
</p>

<h1 align="center">BITL — Being In The Loop</h1>

<p align="center">
  <b>A local board for all your AI coding agents — see which ones are waiting for you.</b><br>
  Claude Code · Codex · Antigravity
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue" alt="License: AGPL-3.0"></a>
  <a href="https://www.npmjs.com/package/@usebitl/cli"><img src="https://img.shields.io/npm/v/@usebitl/cli" alt="npm"></a>
</p>

<p align="center"><img src="docs/board.png" alt="The BITL board: one agent waiting for approval, two running, one done and ready for review" width="900"></p>

When you run several agents at once, they spend a lot of time stuck: one is waiting on a permission prompt in a terminal you can't see, another finished ten minutes ago and is waiting for your review. BITL puts every session on one board, sorted by what it needs from you.

- **Waiting on you**: a permission prompt or a question.
- **Running**: what it's doing right now (`Bash: pnpm test`, `Edit: src/app.ts`).
- **Needs review**: the turn is done; the last answer is right on the card.
- Sessions that are already running show up too. No wrapper and no change to how you start your agents. BITL listens to their hooks.

This is the **local edition**. It runs on your PC (`127.0.0.1` only), needs no account, and keeps everything in a local SQLite file.

## Quick start

Requires Node.js 22.5 or later.

```sh
npx @usebitl/cli start            # starts the board; open the "Connect a browser" link it prints
npx @usebitl/cli install claude   # in another terminal: add Claude Code hooks (a backup is made)
```

Now use Claude Code as usual, in any folder. Its sessions appear on the board.

To keep the `bitl` command around, use `npm install -g @usebitl/cli` and then run `bitl start`.

| Agent | Install | What BITL sees |
|---|---|---|
| Claude Code | `bitl install claude` | Prompts, tool use, permission prompts, questions, turn end, subagents |
| Codex | `bitl install codex` | Prompts, tool use, permission prompts, turn end. Trust the hooks once in Codex with `/hooks` |
| Antigravity | `bitl install antigravity` | Prompts, tool use, turn end. Approval waits in the CLI, but not yet in the IDE |

`bitl uninstall <agent>` removes only what BITL added. `bitl status` prints the board in your terminal.

## Never in your agent's way

Hooks run inside your agent, so they follow strict rules:

- They are async, write nothing to stdout, always exit 0, and use short timeouts.
- If the BITL server isn't running, events go into a queue (`~/.bitl/queue.jsonl`) and the hook returns right away. The queue is processed when the server starts.
- BITL never answers a prompt for you or holds one back. The terminal stays in control.

## Your content stays encrypted

Even on your own PC, the server only sees signals: event type, time, and the kind of wait.

- **Minimized in the hook.** Raw payloads, full tool inputs (the code an agent edits) and tool output are dropped. What's left is the tool name, a one-line summary, and the start of prompts and answers.
- **Encrypted per field** with AES-256-GCM before it leaves the hook. The session key is bound as AAD, and fields are padded to 32-byte blocks.
- **The server refuses plaintext.** A content field that isn't sealed is rejected.
- **Only your browser decrypts.** The key lives in `~/.bitl/key` and reaches a browser through the link `bitl start` prints. It sits after `#`, so it is never sent to the server. Delete the key and old records can't be read by anyone.

## How it works

```
agent hook ─▶ bitl-hook.mjs ─▶ normalize ─▶ minimize ─▶ encrypt ─▶ local server ─▶ SSE ─▶ browser (decrypts)
                                                                   (state machine on signals only)
```

```
packages/
  adapters/  hook scripts: normalize → minimize → encrypt → send (queue when the server is down)
  shared/    normalization, sealing, crypto, decryption, wire validation
  server/    Hono, state machine (signals only), SSE, SQLite store
  cli/       bitl start / install / uninstall / status / pair
  web/       React + Vite + Tailwind board (decrypts in the browser)
```

Data: `~/.bitl/bitl.db`, key: `~/.bitl/key`. You can override them with `BITL_HOME`, `BITL_PORT`, `BITL_HOST` and `BITL_KEY`. Event timelines are kept for 14 days (`BITL_EVENT_RETENTION_DAYS`), and session summaries stay.

## From source

Requires Node.js 22.5 or later and pnpm.

```sh
pnpm install               # also builds the hook bundle (packages/adapters/dist)
pnpm start                 # builds the web UI and starts the server
pnpm bitl install claude
```

`pnpm test` and `pnpm typecheck` run the checks. For development, run `pnpm dev:server` and `pnpm dev:web` (web on http://localhost:5173, with `/api` proxied to 7777).

## On your phone

The local edition stays on one PC. [usebitl.com](https://usebitl.com) is the hosted version. It adds your phone, push notifications when an agent is waiting, approving permission prompts remotely, and several PCs on one account, with the same end-to-end encryption.

The local edition is free and open source (AGPL-3.0). usebitl.com is free during beta; paid plans will be announced at least 30 days ahead.

## License

[GNU AGPL-3.0](LICENSE). If you run a modified version as a network service, you must offer its source to its users.

"BITL" and the BITL logo identify the service at usebitl.com. Please use a different name and logo for a fork you distribute.

---

## 한국어

**여러 AI 코딩 에이전트를 한 화면에서 — 어떤 작업이 나를 기다리는지 보여 줍니다.** Claude Code, Codex, Antigravity 의 세션을 "나를 기다림(권한 요청·질문) / 실행 중 / 검토 필요" 로 나눠 보여 줍니다. 이미 실행 중인 세션도 hook 으로 잡으므로 에이전트를 실행하는 방법은 바뀌지 않습니다.

이 저장소는 **로컬판**입니다. 내 PC 에서만(`127.0.0.1`) 돌고, 계정이 필요 없으며, 모든 기록을 PC 의 SQLite 파일에 둡니다.

```sh
npx @usebitl/cli start            # 보드 시작 → 출력되는 "브라우저 연결" 링크를 연다 (Node.js 22.5 이상)
npx @usebitl/cli install claude   # 다른 터미널에서: Claude Code hook 등록 (백업 생성)
```

- hook 은 에이전트를 막거나 느리게 하지 않습니다. 서버가 꺼져 있으면 이벤트를 `~/.bitl/queue.jsonl` 에 쌓고 바로 돌아갑니다.
- 질문·답변·명령은 PC 에서 암호화됩니다. 서버는 평문을 받지 않고, 키(`~/.bitl/key`)가 있는 브라우저만 내용을 봅니다.
- 휴대폰·푸시 알림·원격 승인·여러 PC 는 [usebitl.com](https://usebitl.com) 에서 쓸 수 있습니다 (베타 기간 무료, 유료 전환은 적어도 30일 전에 알립니다).

라이선스는 [GNU AGPL-3.0](LICENSE) 입니다. 고친 버전을 네트워크 서비스로 운영하면 그 이용자에게 소스를 제공해야 합니다. "BITL" 이름과 로고는 usebitl.com 서비스를 가리키므로, 배포하는 포크에는 다른 이름과 로고를 써 주세요.
