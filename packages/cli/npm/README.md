# @usebitl/cli

Command-line companion for [BITL](https://usebitl.com) — stay in the loop of every AI agent you run.

BITL shows what Claude Code, Codex and Antigravity are doing and where they are waiting on your call, in your PC browser and on your phone. Prompts, answers and commands are end-to-end encrypted on your PC before they leave it.

## Install

```sh
npm install -g @usebitl/cli
```

Requires Node.js 20.11 or later. The command is `bitl`.

## Connect

```sh
bitl login                    # once per PC — approve in the browser that opens
bitl install claude           # Claude Code
bitl install codex            # Codex — then trust the bitl hooks in Codex's /hooks
bitl install antigravity      # Antigravity (agy CLI and IDE)
```

`bitl uninstall <claude|codex|antigravity>` removes only what BITL added. Run `bitl` for all commands.

The hooks run small scripts copied to `~/.bitl/adapters`. They never block or slow down your agent.

---

## 한국어

[BITL](https://usebitl.com) 을 쓰기 위한 명령줄 도구입니다. Claude Code, Codex, Antigravity 가 지금 무엇을 하는지, 어디서 내 결정을 기다리는지 PC 브라우저와 휴대폰에서 봅니다. 질문·답변·명령은 PC 에서 종단간 암호화되어 전송됩니다.

```sh
npm install -g @usebitl/cli
bitl login                    # PC 마다 한 번 — 열리는 브라우저에서 승인
bitl install claude           # Claude Code
bitl install codex            # Codex — 설치 뒤 Codex 의 /hooks 에서 bitl hook 을 신뢰(trust)
bitl install antigravity      # Antigravity (agy CLI·IDE)
```

Node.js 20.11 이상이 필요합니다. 문의: support@usebitl.com
