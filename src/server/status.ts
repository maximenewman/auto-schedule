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
  canvasConfigured: boolean;
  canvasTokenUpdatedAt: string | null;
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

export async function canvasTokenStatus(
  store: Store,
  userId: number,
): Promise<{ configured: boolean; updatedAt: string | null }> {
  const row = await store.getCanvasToken(userId);
  if (!row) return { configured: false, updatedAt: null };
  return {
    configured: true,
    updatedAt: row.updatedAt ? row.updatedAt.toISOString() : null,
  };
}
