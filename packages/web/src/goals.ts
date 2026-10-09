import { type ContentKeys, open, seal, toBase64Url } from '@bitl/shared/client';
import { contentKeys } from './keys';

/**
 * 목표 — 여러 에이전트 카드를 사람이 정한 목적 하나로 묶는다.
 * 제목과 연결한 카드(세션 key) 목록은 한 덩어리로 봉인한다 (AAD = goal:<id>). 서버는 어떤 카드가 한 목표인지 모른다.
 * 고칠 때는 최신 내용에 같은 변경을 다시 적용한다 — 다른 기기가 먼저 고쳤으면(409) 받은 최신본에 다시 적용해 재시도.
 */

/** 서버가 주는 그대로 */
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
  /** 연결한 카드의 세션 key */
  members: string[];
}

export interface Goal extends GoalContent {
  id: string;
  version: number;
  createdAt: string;
  closedAt?: string;
  /** 이 브라우저의 키로 열 수 없음 */
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
 * 내용 바꾸기: change 를 최신 내용에 적용해 저장한다. 다른 기기가 먼저 고쳤으면 그 최신본에 다시 적용 (최대 3번).
 * 예) 카드 넣기: (c) => ({ ...c, members: [...c.members, key] })
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

/** 마치기·다시 열기 (내용은 그대로) */
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

/** 카드를 목표에 넣기·빼기 */
export const toggleMember = (goal: Goal, key: string, on: boolean) =>
  changeGoal(goal, (c) => ({ ...c, members: on ? [...c.members, key] : c.members.filter((m) => m !== key) }));
