import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const AGENT_ERROR_DIR = resolve('logs/agent-errors');
const GOOGLE_TOKEN_PATH = resolve('data/auth/google.json');
const COURSYS_COOKIE_PATH = resolve('data/auth/coursys.json');

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

export function googleAuthExists(): boolean {
  return existsSync(GOOGLE_TOKEN_PATH);
}

/**
 * CourSys cookies don't carry a hard expiry we can trust (some are session
 * cookies). Use file mtime as a proxy and assume the SFU CAS session lasts
 * roughly 7 days from the last successful login.
 */
export function coursysCookieAge(): { ok: boolean; expiresInDays: number | null } {
  if (!existsSync(COURSYS_COOKIE_PATH)) return { ok: false, expiresInDays: null };
  try {
    const raw = JSON.parse(readFileSync(COURSYS_COOKIE_PATH, 'utf8')) as {
      saved_at?: string;
    };
    if (!raw.saved_at) return { ok: true, expiresInDays: null };
    const savedAt = new Date(raw.saved_at).getTime();
    const ageDays = (Date.now() - savedAt) / (24 * 60 * 60 * 1000);
    const remaining = Math.max(0, Math.round(7 - ageDays));
    return { ok: remaining > 0, expiresInDays: remaining };
  } catch {
    return { ok: false, expiresInDays: null };
  }
}
