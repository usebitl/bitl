import type { Raw } from '../scenarios.js';

/**
 * Builds raw records the way an agent's hooks send them. Payloads copy the shape of real hook dumps (~/.bitl/dumps),
 * with made-up content. Each record is stamped `gapMs` after the previous one; a negative gap makes a late (older) event
 */
export function recorder(source: string, base: Record<string, unknown>) {
  let clock = Date.parse('2026-10-18T00:00:00.000Z');
  return (payload: Record<string, unknown>, gapMs = 1000): Raw => {
    clock += gapMs;
    return { source, receivedAt: new Date(clock).toISOString(), payload: { ...base, ...payload } };
  };
}
