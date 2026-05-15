import { randomBytes } from 'node:crypto';
import type { Store } from '../state/store.js';

export const SESSION_COOKIE = 'as_session';
export const SESSION_TTL_DAYS = 30;

function generateSessionId(): string {
  return randomBytes(32).toString('base64url');
}

export async function startSession(
  store: Store,
  userId: number,
): Promise<{ sessionId: string; expiresAt: Date }> {
  const sessionId = generateSessionId();
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
  await store.createSession(sessionId, userId, expiresAt);
  return { sessionId, expiresAt };
}

export async function resolveSession(
  store: Store,
  sessionId: string,
): Promise<number | null> {
  const row = await store.getActiveSession(sessionId);
  return row?.userId ?? null;
}

export async function endSession(store: Store, sessionId: string): Promise<void> {
  await store.destroySession(sessionId);
}

export function cookieOptions(expiresAt: Date) {
  // `secure: 'auto'` is what we want in @fastify/cookie 11+: it sets Secure
  // when the request was over HTTPS, off otherwise. Lets localhost dev work
  // without HTTPS while still enforcing Secure in production.
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    expires: expiresAt,
    signed: true,
  };
}
