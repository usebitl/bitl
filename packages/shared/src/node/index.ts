// Node only (adapters, CLI). Not included in the browser bundle.
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
export * from './update-check.js';

/** Raw input (hook payload/status report) → normalize → enrich → minimize and seal. null if it can't be parsed */
export async function prepareRaw(rec: RawRecord, opts: { keys?: ContentKeys; home?: string; enrich?: boolean } = {}): Promise<WireRecord | null> {
  // For Antigravity the question/answer text is filled from the transcript (readable only on this PC)
  const filled = rec.source === 'antigravity' && opts.enrich !== false ? { ...rec, payload: await fillAntigravityText(rec.payload) } : rec;
  const e = normalizeRecord(filled);
  if (!e) return null;
  const extra = opts.enrich === false ? {} : await enrichEvent(e);
  const keys = opts.keys ?? (await loadKeys(opts.home ?? bitlHome()));
  return prepareRecord(e, sealerFor(keys), extra);
}

/** For adapters: picks the destination (cloud account / local server) and returns a record sealed with that destination's key. kid is used to check the key matches when flushing the queue */
export async function prepareForTarget(rec: RawRecord, home = bitlHome()) {
  const target = resolveTarget(home);
  const keys = await target.keys();
  const record = await prepareRaw(rec, { keys, home });
  return { kind: target.kind, url: target.url, headers: target.headers, kid: keys.kid, record };
}
