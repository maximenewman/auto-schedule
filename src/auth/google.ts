import { google } from 'googleapis';
import type { OAuth2Client, Credentials } from 'google-auth-library';
import type { Store } from '../state/store.js';
import { logger } from '../logger.js';

export const SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar',
];

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`missing env var ${name} — copy .env.example to .env and fill it in`);
  }
  return value;
}

export function publicBaseUrl(): string {
  // Used to build the OAuth redirect URI. In dev this is
  // http://localhost:5174 (or whatever SERVER_PORT is); in prod set
  // PUBLIC_BASE_URL=https://<app>.fly.dev.
  const explicit = process.env.PUBLIC_BASE_URL;
  if (explicit) return explicit.replace(/\/+$/, '');
  const host = process.env.SERVER_HOST ?? '127.0.0.1';
  const port = process.env.SERVER_PORT ?? '5174';
  return `http://${host}:${port}`;
}

export function googleRedirectUri(): string {
  return `${publicBaseUrl()}/auth/google/callback`;
}

/** Build a fresh OAuth2 client with credentials but no tokens attached. */
export function buildOAuthClient(): OAuth2Client {
  const clientId = requireEnv('GOOGLE_OAUTH_CLIENT_ID');
  const clientSecret = requireEnv('GOOGLE_OAUTH_CLIENT_SECRET');
  return new google.auth.OAuth2(clientId, clientSecret, googleRedirectUri());
}

export class GoogleAuthMissing extends Error {
  constructor(userId: number) {
    super(`user ${userId} has no Google token on file — sign in again`);
    this.name = 'GoogleAuthMissing';
  }
}

/**
 * Return an OAuth2Client wired up with the given user's persisted credentials,
 * ready to make API calls. Tokens refreshed by the SDK are written back to the
 * DB on the way out.
 */
export async function getAuthorizedClient(
  store: Store,
  userId: number,
): Promise<OAuth2Client> {
  const tokens = await store.getGoogleTokens(userId);
  if (!tokens || !tokens.refreshToken) {
    throw new GoogleAuthMissing(userId);
  }
  const client = buildOAuthClient();
  client.setCredentials({
    refresh_token: tokens.refreshToken,
    access_token: tokens.accessToken ?? undefined,
    expiry_date: tokens.accessTokenExpires?.getTime(),
    scope: tokens.scope ?? undefined,
    token_type: 'Bearer',
  });
  client.on('tokens', (newTokens: Credentials) => {
    // googleapis fires this when it auto-refreshes. We never get a fresh
    // refresh_token here (only on the initial consent), but the new
    // access_token is worth persisting so other processes don't hammer the
    // refresh endpoint.
    void store
      .saveGoogleTokens(userId, {
        refreshToken: newTokens.refresh_token ?? null,
        accessToken: newTokens.access_token ?? null,
        accessTokenExpires: newTokens.expiry_date
          ? new Date(newTokens.expiry_date)
          : null,
        scope: newTokens.scope ?? tokens.scope ?? null,
      })
      .catch((err) => {
        logger.warn({ err, userId }, 'failed to persist refreshed google token');
      });
  });
  return client;
}

export function buildGoogleAuthUrl(state: string): string {
  const client = buildOAuthClient();
  return client.generateAuthUrl({
    access_type: 'offline',
    // Only `prompt: 'consent'` guarantees we receive a refresh_token — without
    // it Google omits the refresh on subsequent sign-ins by the same user.
    prompt: 'consent',
    scope: SCOPES,
    state,
    include_granted_scopes: true,
  });
}

export interface GoogleProfile {
  sub: string;
  email: string;
  name: string | null;
}

export async function exchangeCodeForTokens(
  code: string,
): Promise<{ credentials: Credentials; profile: GoogleProfile }> {
  const client = buildOAuthClient();
  const { tokens } = await client.getToken(code);
  if (!tokens.id_token) {
    throw new Error('google did not return an id_token — required for profile lookup');
  }
  const ticket = await client.verifyIdToken({
    idToken: tokens.id_token,
    audience: requireEnv('GOOGLE_OAUTH_CLIENT_ID'),
  });
  const payload = ticket.getPayload();
  if (!payload?.sub || !payload.email) {
    throw new Error('google id_token missing sub/email claims');
  }
  return {
    credentials: tokens,
    profile: {
      sub: payload.sub,
      email: payload.email,
      name: payload.name ?? null,
    },
  };
}
