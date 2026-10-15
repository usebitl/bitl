import { describe, expect, it } from 'vitest';
import { isEmptySession } from '../src/session.js';

describe('isEmptySession', () => {
  it('a session with only a start (or start and end) is empty', () => {
    expect(isEmptySession({ status: 'idle', turnCount: 0, toolCount: 0 })).toBe(true);
    expect(isEmptySession({ status: 'ended', turnCount: 0, toolCount: 0 })).toBe(true);
  });

  it('a prompt or a tool call makes it a real session', () => {
    expect(isEmptySession({ status: 'idle', turnCount: 1, toolCount: 0 })).toBe(false);
    expect(isEmptySession({ status: 'ended', turnCount: 0, toolCount: 2 })).toBe(false);
  });

  it('a session waiting on the user or failing is never hidden', () => {
    expect(isEmptySession({ status: 'waiting_for_you', turnCount: 0, toolCount: 0 })).toBe(false);
    expect(isEmptySession({ status: 'error', turnCount: 0, toolCount: 0 })).toBe(false);
  });
});
