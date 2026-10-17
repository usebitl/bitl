// Plays every scenario (scenarios.ts) with every agent's hook records (agents/*.ts) through the real path:
// raw hook payload → normalize (shared) → signal + content → state machine (server). Checks the card after each step.
// Adding an agent: write agents/<agent>.ts answering every scenario, and add it to AGENTS below.
import { isEmptySession, normalizeRecord, splitEvent, type StoredSession } from '@bitl/shared';
import { describe, expect, it } from 'vitest';
import { applyEvent } from '../../src/state.js';
import { antigravity } from './agents/antigravity.js';
import { claudeCode } from './agents/claude-code.js';
import { codex } from './agents/codex.js';
import { type AgentFixture, type Expect, type Raw, SCENARIOS, type Scenario } from './scenarios.js';

const AGENTS: AgentFixture[] = [claudeCode, codex, antigravity];

/** Content isn't sealed in this test, so the card's fields hold plain text */
const plain = (s: StoredSession, field: keyof StoredSession['enc']) => s.enc[field] as unknown as string | undefined;

function feed(prev: StoredSession | undefined, records: Raw[]): StoredSession | undefined {
  let s = prev;
  for (const rec of records) {
    const e = normalizeRecord(rec);
    if (!e) continue; // dropped on purpose (e.g. agy's later model calls)
    const { signal, content } = splitEvent(e);
    s = applyEvent(s, signal, content).session;
  }
  return s;
}

function check(s: StoredSession | undefined, want: Expect, step: string) {
  expect(s, `${step}: no card yet`).toBeDefined();
  const card = s!;
  const at = (what: string) => `${step} → ${what}`;
  if (want.status !== undefined) expect(card.status, at('status')).toBe(want.status);
  if (want.waitingReason !== undefined) expect(card.waitingReason, at('waiting reason')).toBe(want.waitingReason ?? undefined);
  if (want.turns !== undefined) expect(card.turnCount, at('turns')).toBe(want.turns);
  if (want.tools !== undefined) expect(card.toolCount, at('tools')).toBe(want.tools);
  if (want.subagents !== undefined) expect(card.subagentsRunning, at('subagents')).toBe(want.subagents);
  if (want.offBoard !== undefined) expect(isEmptySession(card), at('off the board')).toBe(want.offBoard);
  if (want.title !== undefined) expect(plain(card, 'title'), at('title')).toBe(want.title);
  if (want.lastMessage !== undefined) expect(plain(card, 'lastMessage'), at('last message')).toBe(want.lastMessage);
  if (want.activity === null) expect(plain(card, 'currentActivity'), at('activity')).toBeUndefined();
  else if (want.activity !== undefined) expect(plain(card, 'currentActivity'), at('activity')).toContain(want.activity);
  if (want.cleared !== undefined) expect(Boolean(card.cleared), at('cleared')).toBe(want.cleared);
}

function play(scenario: Scenario, steps: Record<string, Raw[] | null>) {
  let s: StoredSession | undefined;
  for (const { name, expect: want, userClears } of scenario.steps) {
    const records = steps[name];
    if (records === null || records === undefined) continue; // no such moment for this agent
    s = feed(s, records);
    if (userClears && s) s = { ...s, cleared: true };
    check(s, want, name);
  }
}

for (const fixture of AGENTS) {
  describe(fixture.agent, () => {
    for (const scenario of SCENARIOS as readonly Scenario[]) {
      const p = fixture[scenario.id as keyof AgentFixture] as Exclude<AgentFixture[keyof AgentFixture], string>;
      if ('unsupported' in p) it.skip(`${scenario.id} — unsupported: ${p.unsupported}`, () => {});
      else if ('unverified' in p) it.todo(`${scenario.id} — unverified: ${p.unverified}`);
      else if (p.knownGap) {
        const gap = p.knownGap;
        it(`${scenario.id} — known gap at "${gap.at}": ${gap.why}`, () => {
          let failure: unknown;
          try {
            play(scenario, p.steps);
          } catch (err) {
            failure = err;
          }
          expect(failure, 'the known gap no longer fails — it looks fixed: drop knownGap from the fixture').toBeDefined();
          expect(String((failure as Error).message), 'it fails, but not at the known step').toContain(`${gap.at} →`);
        });
      }
      else it(scenario.id, () => play(scenario, p.steps));
    }
  });
}

describe('fixtures', () => {
  it('every agent answers every scenario, and every step it plays has a name the scenario knows', () => {
    for (const fixture of AGENTS) {
      for (const scenario of SCENARIOS as readonly Scenario[]) {
        const p = fixture[scenario.id as keyof AgentFixture];
        expect(p, `${fixture.agent}: ${scenario.id}`).toBeDefined();
        if (typeof p === 'object' && 'steps' in p) {
          expect(Object.keys(p.steps).sort(), `${fixture.agent}: ${scenario.id}`).toEqual(scenario.steps.map((s) => s.name).sort());
        }
      }
    }
  });

  it('every record an agent sends is understood (normalizes), except the ones dropped on purpose', () => {
    const dropped = new Set(['PostInvocation', 'PreInvocation']); // agy: model calls after the first, and their ends
    for (const fixture of AGENTS)
      for (const scenario of SCENARIOS as readonly Scenario[]) {
        const p = fixture[scenario.id as keyof AgentFixture];
        if (typeof p !== 'object' || !('steps' in p)) continue;
        for (const records of Object.values(p.steps as Record<string, Raw[] | null>))
          for (const rec of records ?? []) {
            const name = String(rec.payload.hook_event_name);
            if (!normalizeRecord(rec)) expect(dropped.has(name), `${fixture.agent}: ${scenario.id} sends ${name}, which does not normalize`).toBe(true);
          }
      }
  });
});
