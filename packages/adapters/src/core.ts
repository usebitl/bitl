// 어댑터 번들 진입점 (pnpm --filter @bitl/adapters build → dist/core.mjs).
// hook·MCP 는 설치된 Node 로 .mjs 를 바로 실행하므로, shared(TypeScript)의 정규화·최소화·암호화를 미리 묶어 둔다.
export { agyWatchStep, prepareForTarget, prepareRaw, requestRemoteApproval } from '@bitl/shared/node';
