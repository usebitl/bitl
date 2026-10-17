// Agent-agnostic scenarios: what a card must look like after each step of a session.
// Every agent answers every scenario in agents/<agent>.ts — with the hook payloads it really sends, or why it can't.
// Each scenario says why it exists: most of them are bugs we hit while wiring Claude Code, Codex and Antigravity.
import type { SessionStatus, WaitingReason } from '@bitl/shared';

/** What to check after a step. Only the listed fields are checked */
export interface Expect {
  status?: SessionStatus;
  /** null: no waiting reason */
  waitingReason?: WaitingReason | null;
  turns?: number;
  tools?: number;
  subagents?: number;
  /** Kept off the board (no prompt and no tool call yet) */
  offBoard?: boolean;
  /** Plain text the state machine moved into the card (the test feeds unsealed content) */
  title?: string;
  lastMessage?: string;
  /** Text the current activity contains (tool names differ per agent); null: no activity */
  activity?: string | null;
  cleared?: boolean;
}

export interface Scenario {
  id: string;
  /** What it checks, and why it exists */
  about: string;
  /** userClears: the user presses "Clear" right after this step's records */
  steps: { name: string; expect: Expect; userClears?: true }[];
}

export const SCENARIOS = [
  {
    id: 'basic-turn',
    about: 'One instruction from start to "needs review": the card shows the first instruction as its title, what the agent is doing now, and its last answer.',
    steps: [
      { name: 'session starts', expect: { status: 'idle', turns: 0, offBoard: true } },
      { name: 'user gives an instruction', expect: { status: 'running', turns: 1, title: 'Fix the login bug', offBoard: false } },
      { name: 'a tool starts', expect: { status: 'running', tools: 1, activity: 'pnpm test' } },
      { name: 'the tool finishes', expect: { status: 'running', tools: 1 } },
      { name: 'the turn ends', expect: { status: 'needs_review', lastMessage: 'Fixed it', activity: null } },
    ],
  },
  {
    id: 'permission-wait',
    about: 'A tool needs approval: the card waits on the user until the tool runs, then goes back to running.',
    steps: [
      { name: 'user gives an instruction', expect: { status: 'running', turns: 1 } },
      { name: 'the agent asks to run a tool', expect: { status: 'waiting_for_you', waitingReason: 'permission' } },
      { name: 'the user allows it and the tool finishes', expect: { status: 'running', waitingReason: null } },
      { name: 'the turn ends', expect: { status: 'needs_review' } },
    ],
  },
  {
    id: 'permission-race',
    about:
      'Async hooks fire tens of ms apart, so the tool start can be stamped AFTER the approval request (18 ms seen in Codex). That late tool start must not end the wait (PERMISSION_RACE_MS).',
    steps: [
      { name: 'user gives an instruction', expect: { status: 'running' } },
      { name: 'approval request, then the same tool start a few ms later', expect: { status: 'waiting_for_you', waitingReason: 'permission' } },
      { name: 'the user allows it and the tool finishes', expect: { status: 'running' } },
    ],
  },
  {
    id: 'question',
    about: 'The agent stops to ask the user a question (multiple choice). It is not running — it waits on the user until answered.',
    steps: [
      { name: 'user gives an instruction', expect: { status: 'running' } },
      { name: 'the agent asks a question', expect: { status: 'waiting_for_you', waitingReason: 'question' } },
      { name: 'the user answers', expect: { status: 'running', waitingReason: null } },
    ],
  },
  {
    id: 'late-event',
    about: 'Hooks can arrive out of order: a tool end stamped before the turn end but delivered after it must not turn "needs review" back into running.',
    steps: [
      { name: 'instruction and a tool start', expect: { status: 'running' } },
      { name: 'the turn ends', expect: { status: 'needs_review' } },
      { name: 'the tool end arrives late (older timestamp)', expect: { status: 'needs_review' } },
    ],
  },
  {
    id: 'idle-reminder',
    about: 'About a minute after a turn ends, the agent may remind that it waits for input. That is still "needs review", not an urgent "waiting for you".',
    steps: [
      { name: 'instruction, then the turn ends', expect: { status: 'needs_review' } },
      { name: 'the idle reminder arrives', expect: { status: 'needs_review', waitingReason: null } },
    ],
  },
  {
    id: 'interrupt',
    about: 'The user stops the agent mid-turn. The card must not stay running forever.',
    steps: [
      { name: 'instruction and a tool start', expect: { status: 'running' } },
      { name: 'the user interrupts', expect: { status: 'needs_review' } },
    ],
  },
  {
    id: 'error',
    about: 'The turn fails (API error, rate limit): the card shows the error and asks for attention.',
    steps: [
      { name: 'user gives an instruction', expect: { status: 'running' } },
      { name: 'the turn fails', expect: { status: 'error' } },
    ],
  },
  {
    id: 'subagent',
    about:
      "Subagents run inside a turn: named ones are counted, the agent's own internal ones are not, and events from inside a subagent never end the parent's turn.",
    steps: [
      { name: 'user gives an instruction', expect: { status: 'running', turns: 1 } },
      { name: 'a named subagent starts', expect: { subagents: 1 } },
      { name: 'the subagent works and finishes its own turn', expect: { status: 'running', turns: 1, subagents: 1 } },
      { name: 'the subagent stops', expect: { subagents: 0 } },
      { name: 'an internal (unnamed) subagent comes and goes', expect: { subagents: 0 } },
    ],
  },
  {
    id: 'session-end-and-resume',
    about: 'Closing the session ends the card; reopening the same session brings it back.',
    steps: [
      { name: 'instruction, then the turn ends', expect: { status: 'needs_review' } },
      { name: 'the session ends', expect: { status: 'ended' } },
      { name: 'the session is reopened', expect: { status: 'idle' } },
    ],
  },
  {
    id: 'relay-only-session',
    about:
      'A session that never got an instruction but relays notifications about other sessions ("X needs your input") must stay off the board — otherwise an untitled card sits in "waiting for you".',
    steps: [
      { name: 'the session starts', expect: { offBoard: true } },
      { name: 'it relays another session needing input', expect: { offBoard: true } },
    ],
  },
  {
    id: 'cleared-comes-back',
    about:
      '"Clear" hides a card until its agent works again. Quiet events (the idle reminder, notices, the session ending) must not bring it back; a new instruction must.',
    steps: [
      { name: 'instruction, then the turn ends, and the user clears', expect: { status: 'needs_review', cleared: true }, userClears: true },
      { name: 'a quiet event arrives', expect: { cleared: true } },
      { name: 'the user gives a new instruction', expect: { status: 'running', cleared: false } },
    ],
  },
  {
    id: 'no-false-wait',
    about:
      'An approval the agent settles by itself (no human involved) must not show the card as "waiting for you" or send a push.',
    steps: [
      { name: 'user gives an instruction', expect: { status: 'running' } },
      { name: 'an approval request the agent answers itself', expect: { status: 'running' } },
      { name: 'the tool finishes', expect: { status: 'running' } },
    ],
  },
] as const satisfies readonly Scenario[];

export type ScenarioId = (typeof SCENARIOS)[number]['id'];
type StepName<Id extends ScenarioId> = Extract<(typeof SCENARIOS)[number], { id: Id }>['steps'][number]['name'];

/** One raw record as the adapter receives it (hook payload; Antigravity's event name goes into hook_event_name) */
export interface Raw {
  source: string;
  receivedAt: string;
  payload: Record<string, unknown>;
}

/**
 * How an agent plays a scenario:
 *   steps       — the records each step sends. [] sends nothing but still checks; null skips the step (no such moment for this agent)
 *   knownGap    — with steps: it fails today at step `at`, and we know why. The test checks it still fails exactly there,
 *                 and turns red once it's fixed (then drop knownGap)
 *   unsupported — the agent can't do this at all (why)
 *   unverified  — not yet tried on the real agent (what to try). Shows up as a todo
 */
export type Play<Id extends ScenarioId> =
  | { steps: Record<StepName<Id>, Raw[] | null>; knownGap?: { at: StepName<Id>; why: string } }
  | { unsupported: string }
  | { unverified: string };

export type AgentFixture = { agent: string } & { [Id in ScenarioId]: Play<Id> };
