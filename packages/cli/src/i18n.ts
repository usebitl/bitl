// CLI output strings — Korean (source) and English. Same approach as the web (packages/web/src/i18n): en must have every ko key to compile.
// Language: BITL_LANG (ko|en) → LC_ALL / LC_MESSAGES / LANG → OS locale (via Intl on Windows, which lacks the env vars) → otherwise English.
// {name} is a placeholder.

export type Lang = 'ko' | 'en';

const ko = {
  'usage.title': 'bitl — AI 에이전트 작업 현황판 (https://usebitl.com)',
  'update.available': '↑ bitl {latest} 가 나왔습니다 (지금 {current}) — npm i -g @usebitl/cli',
  'update.changelog': '  바뀐 점: https://usebitl.com/changelog',
  'usage.start': '서버 시작 (http://127.0.0.1:7777)',
  'usage.status': '현재 세션 요약 (이 PC 의 키로 복호화)',
  'usage.pair': '브라우저에 암호화 키를 넘기는 링크 (브라우저·주소마다 한 번)',
  'usage.pairArgs': '[--url 주소]',
  'usage.loginArgsDefault': '[--url <주소>] [--name 이름] [--no-browser]',
  'usage.loginArgs': '--url <주소> [--name 이름] [--no-browser]',
  'usage.loginDefault': '이 PC 를 계정에 연결 (브라우저에서 승인, 기본 {url})',
  'usage.login': '이 PC 를 클라우드 계정에 연결 (브라우저에서 승인)',
  'usage.logout': '연결 해제 → 다시 로컬 서버로',
  'usage.installClaude': 'Claude Code hook 등록 (기본: ~/.claude/settings.json)',
  'usage.installCodex': 'Codex hook 등록 (~/.codex/config.toml)',
  'usage.installAgy': 'Antigravity hook 등록 (~/.gemini/config/hooks.json, CLI·IDE 공용)',
  'usage.installDesktop': 'Claude Desktop 에 MCP 서버 등록',
  'usage.remote': '원격 승인: 켜면 Claude Code 의 권한 요청을 휴대폰·브라우저에서 허용·거부',
  'usage.remote2': '— 터미널·브라우저·휴대폰 중 먼저 답한 쪽이 적용된다 (폰의 답은 최대 10분 기다림)',

  'err.optionValue': '{name} 뒤에 값을 지정하세요',
  'err.cloudUnreachable': '클라우드 서버에 연결할 수 없습니다 ({url})',
  'err.localUnreachable': '서버에 연결할 수 없습니다 ({url}). bitl start 로 시작하세요.',
  'err.revoked': '이 PC 의 연결이 끊겼습니다 (기기가 제거됨). bitl logout 후 bitl login 으로 다시 연결하세요.',
  'err.remoteUsage': '사용법: bitl remote [on|off]',
  'err.remoteUnsupported': '이 서버는 원격 승인을 지원하지 않습니다 (서버를 새 버전으로 업데이트하세요)',
  'err.noDesktop': 'claude-desktop(로컬 MCP)은 이 패키지에 없습니다. claude.ai 커넥터를 쓰세요: https://usebitl.com/app',
  'err.unknownTarget': '지원하지 않는 대상: {target} — {list}',
  'err.none': '(없음)',
  'err.nodeSqlite': 'bitl start 는 Node.js 22.5 이상이 필요합니다 (node:sqlite). 지금: {version}',
  'err.loginUrl': '연결할 서비스 주소를 지정하세요: bitl login --url https://…',
  'err.agySpace': 'Antigravity 는 공백이 있는 경로를 실행하지 못합니다: {path}',

  'pair.intro': '이 링크를 브라우저에서 한 번 열면 그 브라우저가 키를 기억합니다 (다른 사람에게 보내지 마세요):',
  'pair.otherUrl': '  BITL 을 다른 주소로 연다면 그 주소로: bitl pair --url http://localhost:7788',
  'pair.cloud': '  클라우드 계정은 보통 웹의 "기기" → "기기 추가"(QR) 로 키를 넘깁니다. 이 링크는 예비 방법입니다.',
  'pair.keyFile': '  키 파일: {path} — 지우면 이전 기록을 볼 수 없습니다.',

  'status.cloud': '(클라우드 계정: {url})',
  'status.none': '진행 중인 세션 없음',

  'remote.on': '원격 승인: 켜짐 — Claude Code 의 권한 요청이 휴대폰·브라우저로 갑니다 (화면·알림에서 허용·거부)',
  'remote.off': '원격 승인: 꺼짐 — 권한 요청은 터미널에서 승인합니다',
  'remote.needHook': '  hook 이 없으면 동작하지 않습니다: bitl install claude 를 한 번 다시 실행하세요 (원격 승인 hook 추가)',

  'install.adapter': '어댑터: {path}',
  'install.codexTrust': '아직 동작하지 않습니다: Codex 를 열고 /hooks 에서 bitl hook 을 신뢰(trust)하세요.',
  'install.agyRestart': '실행 중인 agy 는 다시 시작해야 적용됩니다.',
  'install.mcp': 'MCP 서버: {path}',
  'install.desktopRestart': 'Claude Desktop 을 재시작해야 적용됩니다.',
  'install.unchanged': '변경 없음: {file}',
  'install.added': '등록 완료: {file}',
  'install.removed': '제거 완료: {file}',
  'install.backup': '  백업: {path}',

  'start.pair': '  브라우저 연결(처음 한 번): {url}',

  'login.unreachable': '서버에 연결할 수 없습니다 ({where}).',
  'login.unreachableHint': '  서버가 켜져 있는지 확인하세요 — 브라우저로 {origin}/api/health 를 열면 {"ok":true} 가 보여야 합니다.',
  'login.already': '이미 연결돼 있습니다: {url} ({name}). 다시 연결하려면 먼저 bitl logout',
  'login.notBitl': '{url} 는 클라우드 모드 BITL 서버가 아닙니다 (기기 연결 API 가 없음)',
  'login.tooMany': '연결 요청이 너무 많습니다. 잠시 뒤 다시 하세요',
  'login.cannotStart': '연결을 시작할 수 없습니다 ({status})',
  'login.approve': '브라우저에서 이 PC 의 연결을 승인하세요:',
  'login.manual': '  (브라우저가 열리지 않으면 위 주소를 직접 여세요. {min}분 안에)',
  'login.expired': '연결 요청이 만료됐습니다. 다시 bitl login 하세요',
  'login.timeout': '시간 안에 승인되지 않았습니다. 다시 bitl login 하세요',
  'login.denied': '브라우저에서 연결을 거절했습니다',
  'login.noResult': '승인 결과를 받지 못했습니다. 다시 bitl login 하세요',
  'login.badSignature': '경고: 승인한 브라우저를 확인할 수 없어 연결을 중단했습니다 (공개키 서명이 맞지 않음)',
  'login.noKeyBrowser': '이 계정의 키가 없는 브라우저에서 승인했습니다. 카드 내용이 보이는 브라우저에서 승인하도록 다시 bitl login 하세요',
  'login.keyMismatch': '계정에 이미 다른 키가 있습니다. 카드 내용이 보이는 브라우저에서 승인하세요',
  'login.deliverFailed': '키를 넘기지 못했습니다 ({status})',
  'login.connected': '연결됨: 이 PC({name})의 에이전트 작업이 {web} 계정으로 갑니다{via}.',
  'login.via': ' (보내는 주소: {api})',
  'login.next': '  hook 이 아직 없다면: bitl install claude',
  'logout.notConnected': '클라우드 계정에 연결돼 있지 않습니다 (로컬 모드).',
  'logout.done': '연결 해제: {url} ({name}). 이제 이 PC 의 로컬 서버로 보냅니다.',
} as const;

export type MessageKey = keyof typeof ko;

const en: Record<MessageKey, string> = {
  'usage.title': 'bitl — all your AI coding agents in one place (https://usebitl.com)',
  'update.available': '↑ bitl {latest} is available (you have {current}) — npm i -g @usebitl/cli',
  'update.changelog': '  What changed: https://usebitl.com/changelog',
  'usage.start': 'Start the server (http://127.0.0.1:7777)',
  'usage.status': 'Summary of current sessions (decrypted with this PC’s key)',
  'usage.pair': 'Link that hands the encryption key to a browser (once per browser and address)',
  'usage.pairArgs': '[--url URL]',
  'usage.loginArgsDefault': '[--url <URL>] [--name NAME] [--no-browser]',
  'usage.loginArgs': '--url <URL> [--name NAME] [--no-browser]',
  'usage.loginDefault': 'Connect this PC to your account (approve in the browser; default {url})',
  'usage.login': 'Connect this PC to your cloud account (approve in the browser)',
  'usage.logout': 'Disconnect → back to the local server',
  'usage.installClaude': 'Add Claude Code hooks (default: ~/.claude/settings.json)',
  'usage.installCodex': 'Add Codex hooks (~/.codex/config.toml)',
  'usage.installAgy': 'Add Antigravity hooks (~/.gemini/config/hooks.json, shared by CLI and IDE)',
  'usage.installDesktop': 'Add the MCP server to Claude Desktop',
  'usage.remote': 'Remote approval: when on, allow or deny Claude Code permission requests from your phone or browser',
  'usage.remote2': '— whichever of terminal, browser or phone answers first wins (waits up to 10 minutes for the phone)',

  'err.optionValue': 'Give a value after {name}',
  'err.cloudUnreachable': "Can't reach the cloud server ({url})",
  'err.localUnreachable': "Can't reach the server ({url}). Start it with bitl start.",
  'err.revoked': 'This PC was disconnected (the device was removed). Run bitl logout, then bitl login to connect again.',
  'err.remoteUsage': 'Usage: bitl remote [on|off]',
  'err.remoteUnsupported': "This server doesn't support remote approval (update the server to a newer version)",
  'err.noDesktop': 'claude-desktop (local MCP) is not in this package. Use the claude.ai connector: https://usebitl.com/app',
  'err.unknownTarget': 'Unsupported target: {target} — {list}',
  'err.none': '(none)',
  'err.nodeSqlite': 'bitl start needs Node.js 22.5 or later (node:sqlite). Current: {version}',
  'err.loginUrl': 'Give the service URL to connect to: bitl login --url https://…',
  'err.agySpace': "Antigravity can't run a path that contains spaces: {path}",

  'pair.intro': 'Open this link once in a browser and that browser remembers the key (do not share it):',
  'pair.otherUrl': '  If you open BITL at another address, use it: bitl pair --url http://localhost:7788',
  'pair.cloud': '  Cloud accounts usually hand over the key on the web with "Devices" → "Add device" (QR). This link is a fallback.',
  'pair.keyFile': '  Key file: {path} — deleting it makes your earlier history unreadable.',

  'status.cloud': '(cloud account: {url})',
  'status.none': 'No active sessions',

  'remote.on': 'Remote approval: on — Claude Code permission requests go to your phone and browser (allow or deny on screen or from notifications)',
  'remote.off': 'Remote approval: off — approve permission requests in the terminal',
  'remote.needHook': "  It won't work without the hook: run bitl install claude once more (adds the remote approval hook)",

  'install.adapter': 'Adapter: {path}',
  'install.codexTrust': "Not active yet: open Codex and trust the bitl hooks in /hooks.",
  'install.agyRestart': 'Restart any running agy for this to take effect.',
  'install.mcp': 'MCP server: {path}',
  'install.desktopRestart': 'Restart Claude Desktop for this to take effect.',
  'install.unchanged': 'No change: {file}',
  'install.added': 'Added: {file}',
  'install.removed': 'Removed: {file}',
  'install.backup': '  Backup: {path}',

  'start.pair': '  Connect a browser (first time only): {url}',

  'login.unreachable': "Can't reach the server ({where}).",
  'login.unreachableHint': '  Check that the server is running — opening {origin}/api/health in a browser should show {"ok":true}.',
  'login.already': 'Already connected: {url} ({name}). To connect again, run bitl logout first',
  'login.notBitl': "{url} isn't a cloud-mode BITL server (no device connection API)",
  'login.tooMany': 'Too many connection requests. Try again in a moment',
  'login.cannotStart': "Couldn't start connecting ({status})",
  'login.approve': 'Approve connecting this PC in your browser:',
  'login.manual': "  (If the browser doesn't open, open the URL above yourself within {min} min)",
  'login.expired': 'The connection request expired. Run bitl login again',
  'login.timeout': "It wasn't approved in time. Run bitl login again",
  'login.denied': 'The connection was denied in the browser',
  'login.noResult': "Didn't receive the approval result. Run bitl login again",
  'login.badSignature': "Warning: couldn't verify the approving browser, so the connection was stopped (public key signature mismatch)",
  'login.noKeyBrowser': "You approved from a browser that doesn't have this account's key. Run bitl login again and approve in a browser that shows card contents",
  'login.keyMismatch': 'This account already has a different key. Approve in a browser that shows card contents',
  'login.deliverFailed': "Couldn't hand over the key ({status})",
  'login.connected': 'Connected: agent work on this PC ({name}) now goes to your account at {web}{via}.',
  'login.via': ' (sending to {api})',
  'login.next': '  If you have no hooks yet: bitl install claude',
  'logout.notConnected': 'Not connected to a cloud account (local mode).',
  'logout.done': 'Disconnected: {url} ({name}). This PC now sends to its local server.',
};

const DICT: Record<Lang, Record<MessageKey, string>> = { ko, en };

/** Picks the language from the environment (env and locale can be passed in for tests) */
export function detectLang(env: NodeJS.ProcessEnv = process.env, systemLocale = Intl.DateTimeFormat().resolvedOptions().locale): Lang {
  const forced = env.BITL_LANG?.trim().toLowerCase();
  if (forced === 'ko' || forced === 'en') return forced;
  // POSIX locale: earlier wins. 'C' and 'POSIX' carry no language, so move on
  for (const v of [env.LC_ALL, env.LC_MESSAGES, env.LANG]) {
    const s = v?.trim();
    if (!s || s === 'C' || s === 'POSIX' || s.startsWith('C.')) continue;
    return s.toLowerCase().startsWith('ko') ? 'ko' : 'en';
  }
  return systemLocale.toLowerCase().startsWith('ko') ? 'ko' : 'en';
}

/** Current language — reads the environment every time (so tests can switch BITL_LANG) */
export const lang = (): Lang => detectLang();

export function t(key: MessageKey, vars?: Record<string, string | number>): string {
  const text = DICT[lang()][key] ?? ko[key];
  return vars ? text.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : text;
}

/** For tests: both dictionaries */
export const messages = { ko, en };
