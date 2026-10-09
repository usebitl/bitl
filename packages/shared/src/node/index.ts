// Node 전용 (어댑터, CLI). 브라우저 번들에 넣지 않는다.
import { type ContentKeys, sealerFor } from '../crypto.js';
import { normalizeRecord, type RawRecord } from '../normalize.js';
import { prepareRecord, type WireRecord } from '../prepare.js';
import { fillAntigravityText } from './antigravity.js';
import { resolveTarget } from './cloud.js';
import { enrichEvent } from './enrich.js';
import { bitlHome, loadKeys } from './keys.js';

export * from './antigravity.js';
export * from './approve.js';
export * from './cloud.js';
export * from './enrich.js';
export * from './keys.js';

/** 원본(hook 페이로드·상태 보고) → 정규화 → 부가 정보 → 최소화·봉인. 해석할 수 없으면 null */
export async function prepareRaw(rec: RawRecord, opts: { keys?: ContentKeys; home?: string; enrich?: boolean } = {}): Promise<WireRecord | null> {
  // Antigravity 는 질문·답변 원문을 트랜스크립트에서 채운다 (이 PC 에서만 읽을 수 있다)
  const filled = rec.source === 'antigravity' && opts.enrich !== false ? { ...rec, payload: await fillAntigravityText(rec.payload) } : rec;
  const e = normalizeRecord(filled);
  if (!e) return null;
  const extra = opts.enrich === false ? {} : await enrichEvent(e);
  const keys = opts.keys ?? (await loadKeys(opts.home ?? bitlHome()));
  return prepareRecord(e, sealerFor(keys), extra);
}

/** 어댑터용: 보낼 곳(클라우드 계정 / 로컬 서버)을 정하고 그곳의 키로 봉인한 레코드. kid 는 큐를 비울 때 키가 맞는지 보는 데 쓴다 */
export async function prepareForTarget(rec: RawRecord, home = bitlHome()) {
  const target = resolveTarget(home);
  const keys = await target.keys();
  const record = await prepareRaw(rec, { keys, home });
  return { kind: target.kind, url: target.url, headers: target.headers, kid: keys.kid, record };
}
