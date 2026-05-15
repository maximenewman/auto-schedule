import { existsSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Store } from '../state/store.js';

const AGENT_ERROR_DIR = resolve('logs/agent-errors');

export interface SyncStatus {
  lastRunISO: string | null;
  nextRunISO: string | null;
  itemsAddedLastRun: number;
  itemsAddedLastWeek: number;
  agentErrorsLastWeek: number;
  googleAuthOk: boolean;
  coursysAuthOk: boolean;
  coursysExpiresInDays: number | null;
}

/** Count agent-error files whose mtime is within the last 7 days. */
export function countRecentAgentErrors(now: Date = new Date()): number {
  if (!existsSync(AGENT_ERROR_DIR)) return 0;
  const cutoff = now.getTime() - 7 * 24 * 60 * 60 * 1000;
  let n = 0;
  for (const name of readdirSync(AGENT_ERROR_DIR)) {
    if (!name.endsWith('.json')) continue;
    try {
      const st = statSync(resolve(AGENT_ERROR_DIR, name));
      if (st.mtimeMs >= cutoff) n++;
    } catch {
      /* skip */
    }
  }
  return n;
}

export async function googleAuthExists(store: Store, userId: number): Promise<boolean> {
  const tokens = await store.getGoogleTokens(userId);
  return !!tokens?.refreshToken;
}

/**
 * CourSys cookies don't carry a hard expiry we can trust (some are session
 * cookies). Use the upload timestamp as a proxy and assume the SFU CAS
 * session lasts roughly 7 days from the last refresh.
 */
export async function coursysCookieAge(
  store: Store,
  userId: number,
): Promise<{ ok: boolean; expiresInDays: number | null }> {
  const row = await store.getCourSysCookies(userId);
  if (!row || row.cookies.length === 0) {
    return { ok: false, expiresInDays: null };
  }
  if (!row.updatedAt) return { ok: true, expiresInDays: null };
  const ageDays = (Date.now() - row.updatedAt.getTime()) / (24 * 60 * 60 * 1000);
  const remaining = Math.max(0, Math.round(7 - ageDays));
  return { ok: remaining > 0, expiresInDays: remaining };
}
