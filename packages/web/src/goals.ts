import { type ContentKeys, open, seal, toBase64Url } from '@bitl/shared/client';
import { contentKeys } from './keys';

/**
 * Goals — group several agent cards under one purpose set by a person.
 * The title and the list of linked cards (session keys) are sealed as one blob (AAD = goal:<id>). The server doesn't know which cards share a goal.
 * Edits re-apply the same change to the latest content — if another device edited first (409), re-apply to the returned latest version and retry.
 */

/** As returned by the server */
export interface StoredGoal {
  id: string;
  data: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
}

export interface GoalContent {
  title: string;
  /** Session keys of linked cards */
  members: string[];
}

export interface Goal extends GoalContent {
  id: string;
  version: number;
  createdAt: string;
  closedAt?: string;
  /** Cannot be opened with this browser's keys */
  locked?: boolean;
}

const aad = (id: string) => `goal:${id}`;

export const newGoalId = () => toBase64Url(crypto.getRandomValues(new Uint8Array(12)));

export async function openGoal(keys: ContentKeys | null, g: StoredGoal): Promise<Goal> {
  const base = { id: g.id, version: g.version, createdAt: g.createdAt, closedAt: g.closedAt };
  if (!keys) return { ...base, title: '', members: [], locked: true };
  try {
    const c = JSON.parse(await open(keys, g.data, aad(g.id))) as Partial<GoalContent>;
    return { ...base, title: String(c.title ?? ''), members: Array.isArray(c.members) ? c.members.filter((m) => typeof m === 'string') : [] };
  } catch {
    return { ...base, title: '', members: [], locked: true };
  }
}

async function requireKeys(): Promise<ContentKeys> {
  const keys = await contentKeys();
  if (!keys) throw new Error('no keys');
  return keys;
}

const sealContent = async (keys: ContentKeys, id: string, c: GoalContent) =>
  seal(keys, JSON.stringify({ title: c.title.trim().slice(0, 200), members: [...new Set(c.members)] }), aad(id));

const json = (body: unknown) => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

export async function createGoal(c: GoalContent): Promise<void> {
  const keys = await requireKeys();
  const id = newGoalId();
  const res = await fetch('/api/goals', { method: 'POST', ...json({ id, data: await sealContent(keys, id, c) }) });
  if (!res.ok) throw new Error(`goal create ${res.status}`);
}

/**
 * Change content: applies change to the latest content and saves. If another device edited first, re-applies to that latest version (up to 3 times).
 * e.g. adding a card: (c) => ({ ...c, members: [...c.members, key] })
 */
export async function changeGoal(goal: Goal, change: (c: GoalContent) => GoalContent): Promise<void> {
  const keys = await requireKeys();
  let current: Goal = goal;
  for (let attempt = 0; attempt < 3; attempt++) {
    const data = await sealContent(keys, current.id, change({ title: current.title, members: current.members }));
    const res = await fetch(`/api/goals/${current.id}`, { method: 'PUT', ...json({ version: current.version, data }) });
    if (res.ok) return;
    if (res.status !== 409) throw new Error(`goal update ${res.status}`);
    current = await openGoal(keys, ((await res.json()) as { goal: StoredGoal }).goal);
  }
  throw new Error('goal update conflict');
}

/** Finish / reopen (content unchanged) */
export async function setGoalClosed(goal: Goal, closed: boolean): Promise<void> {
  let version = goal.version;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`/api/goals/${goal.id}`, { method: 'PUT', ...json({ version, closed }) });
    if (res.ok) return;
    if (res.status !== 409) throw new Error(`goal close ${res.status}`);
    version = ((await res.json()) as { goal: StoredGoal }).goal.version;
  }
}

export async function deleteGoal(goal: Goal): Promise<void> {
  await fetch(`/api/goals/${goal.id}`, { method: 'DELETE' });
}

/** Add a card to / remove a card from a goal */
export const toggleMember = (goal: Goal, key: string, on: boolean) =>
  changeGoal(goal, (c) => ({ ...c, members: on ? [...c.members, key] : c.members.filter((m) => m !== key) }));
