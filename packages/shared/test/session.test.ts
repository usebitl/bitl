import { describe, expect, it } from 'vitest';
import { isEmptySession } from '../src/session.js';

describe('isEmptySession', () => {
  it('a session without a single prompt or tool call is empty, whatever its status', () => {
    // started (or started and ended), or one that only relays notifications about other sessions while "waiting"
    expect(isEmptySession({ turnCount: 0, toolCount: 0 })).toBe(true);
  });

  it('a prompt or a tool call makes it a real session', () => {
    expect(isEmptySession({ turnCount: 1, toolCount: 0 })).toBe(false);
    expect(isEmptySession({ turnCount: 0, toolCount: 2 })).toBe(false);
  });
});
