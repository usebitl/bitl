# BITL — Being In The Loop

**All your AI coding agents in one place.** BITL shows what Claude Code, Codex and Antigravity are doing on your PC, and which ones are waiting for you — a permission prompt, a question, a finished task to review — so you never leave an agent idle.

This repository is the **local edition**: it runs on your own PC, binds to `127.0.0.1`, needs no account, and stores everything in a local SQLite file. The hosted service at [usebitl.com](https://usebitl.com) adds the things a single PC can't: your phone, push notifications, remote approval, and several PCs on one account.

[한국어](#한국어)

## Quick start

Requires Node.js 22.5 or later (for `node:sqlite`) and pnpm.

```sh
pnpm install               # also builds the hook bundle (packages/adapters/dist)
pnpm start                 # builds the web UI and starts the server — open the "browser link" it prints
pnpm bitl install claude   # Claude Code hooks (~/.claude/settings.json, a backup is made)
```

Then use Claude Code in any folder and its sessions appear on the board, including sessions that are already running.

| Command | |
|---|---|
| `pnpm bitl install claude [--project <dir>]` | Claude Code hooks. `--project` writes only that folder's `.claude/settings.json` |
| `pnpm bitl install codex` | Codex hooks (`~/.codex/config.toml`). Trust them once in Codex with `/hooks` |
| `pnpm bitl install antigravity` | Antigravity hooks (`~/.gemini/config/hooks.json`, CLI and IDE) |
| `pnpm bitl install claude-desktop` | MCP server for Claude Desktop — the agent reports its own status |
| `pnpm bitl uninstall <agent>` | Removes only what BITL added |
| `pnpm bitl status` | Session summary in the terminal |
| `pnpm bitl pair` | Link that hands the decryption key to a browser (once per browser) |
| `pnpm test` / `pnpm typecheck` | Tests and type checks |
| `pnpm dev:server` / `pnpm dev:web` | Development (web on http://localhost:5173, `/api` proxied to 7777) |

The hooks never block or slow down your agent: if the BITL server is not running they queue the event (`~/.bitl/queue.jsonl`) and return immediately.

## Your content stays encrypted

- **Minimized before it leaves the hook.** Raw payloads, full tool inputs (the code an agent edits) and tool output (command results) are dropped. What remains is the tool name, a one-line summary and the start of prompts and answers.
- **Encrypted per field** with AES-256-GCM (session key bound as AAD, padded to 32-byte blocks). The server only reads signals — event type, time, kind of wait — and runs the state machine on those.
- **The server refuses plaintext.** A content field that isn't sealed is rejected.
- **Only your browser decrypts.** The key lives in `~/.bitl/key` and reaches a browser through the `bitl pair` link (after `#`, so it is never sent to the server). Delete the key and nobody can read old records again.

## Layout

```
packages/
  adapters/  hook scripts: normalize → minimize → encrypt → send (queue when the server is down)
  shared/    normalization, sealing, crypto, decryption, wire validation
  server/    Hono, state machine (signals only), SSE, SQLite store
  cli/       bitl start / install / uninstall / status / pair
  web/       React + Vite + Tailwind board (decrypts in the browser)
```

Data: `~/.bitl/bitl.db`, key: `~/.bitl/key` (override with `BITL_HOME`, `BITL_PORT`, `BITL_HOST`, `BITL_KEY`).

## License

[GNU AGPL-3.0](LICENSE). If you run a modified version as a network service, you must offer its source to its users.

"BITL" and the BITL logo identify the service at usebitl.com. Please use a different name and logo for a fork you distribute.

---

## 한국어

**여러 AI 코딩 에이전트를 한곳에서.** Claude Code, Codex, Antigravity 가 지금 무엇을 하는지, 어떤 작업이 나를 기다리는지(권한 요청·질문·검토할 결과) 보여 줍니다.

이 저장소는 **로컬판**입니다. 내 PC 에서만(`127.0.0.1`) 돌고, 계정 없이, 모든 기록을 PC 의 SQLite 파일에 둡니다. 휴대폰·푸시 알림·원격 승인·여러 PC 는 [usebitl.com](https://usebitl.com) 에서 씁니다.

```sh
pnpm install               # hook 번들(packages/adapters/dist)도 함께 빌드
pnpm start                 # 웹 빌드 후 서버 시작 → 출력되는 "브라우저 연결" 링크를 연다
pnpm bitl install claude   # Claude Code hook 등록 (백업 생성)
```

hook 은 에이전트를 막거나 느리게 하지 않습니다. 서버가 꺼져 있으면 이벤트를 `~/.bitl/queue.jsonl` 에 쌓고 바로 돌아갑니다. 질문·답변·명령은 PC 에서 암호화되어 서버는 평문을 받지 않고, 키(`~/.bitl/key`)가 있는 브라우저만 내용을 봅니다.

라이선스는 [GNU AGPL-3.0](LICENSE) 입니다. 고친 버전을 네트워크 서비스로 운영하면 그 이용자에게 소스를 제공해야 합니다. "BITL" 이름과 로고는 usebitl.com 서비스를 가리키므로, 배포하는 포크에는 다른 이름과 로고를 써 주세요.
