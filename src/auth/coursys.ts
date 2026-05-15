import type { Store } from '../state/store.js';

export class CourSysAuthError extends Error {
  constructor(message = 'CourSys session expired') {
    super(message);
    this.name = 'CourSysAuthError';
  }
}

/** Minimal shape we care about from the cookie objects the user uploads.
 *  Matches the export format used by Cookie-Editor / EditThisCookie and the
 *  json output of `document.cookie`-style scripts. */
export interface CourSysCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: number | null;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string | null;
}

export async function loadCookies(
  store: Store,
  userId?: number,
): Promise<CourSysCookie[]> {
  if (userId === undefined) {
    throw new CourSysAuthError('userId required to load CourSys cookies');
  }
  const row = await store.getCourSysCookies(userId);
  if (!row || row.cookies.length === 0) {
    throw new CourSysAuthError(
      `user ${userId} has no CourSys cookies on file — upload them via /api/coursys/cookies`,
    );
  }
  return row.cookies.filter(isValidCookie);
}

export async function saveCookies(
  store: Store,
  userId: number,
  cookies: CourSysCookie[],
): Promise<void> {
  await store.saveCourSysCookies(userId, cookies);
}

export async function clearCookies(store: Store, userId: number): Promise<void> {
  await store.clearCourSysCookies(userId);
}

/**
 * Validate inbound cookie payloads from the UI upload. Permissive on
 * extras (Cookie-Editor adds storeId / hostOnly / etc) but strict on the
 * fields the scraper actually needs.
 */
export function isValidCookie(value: unknown): value is CourSysCookie {
  if (!value || typeof value !== 'object') return false;
  const c = value as Record<string, unknown>;
  return typeof c.name === 'string' && typeof c.value === 'string';
}
