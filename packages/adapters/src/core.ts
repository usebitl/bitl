// Adapter bundle entry point (pnpm --filter @bitl/adapters build → dist/core.mjs).
// Hooks and MCP run the .mjs directly with the installed Node, so shared's (TypeScript) normalization/minimization/encryption is bundled ahead of time.
export { agyWatchStep, prepareForTarget, prepareRaw, requestRemoteApproval } from '@bitl/shared/node';
