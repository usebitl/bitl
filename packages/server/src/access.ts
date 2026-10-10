/**
 * Whether the account may write new data (event ingest, goals, remote approval, notifications).
 * Local mode can always write. The cloud server plugs billing (trial, subscription, read-only) in here.
 */
export interface AccessPolicy {
  canWrite(accountId: string): Promise<boolean>;
}

export const allowAll: AccessPolicy = { canWrite: async () => true };
