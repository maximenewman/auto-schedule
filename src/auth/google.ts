import { google } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createServer } from 'node:http';
import { URL } from 'node:url';
import { logger } from '../logger.js';

const TOKEN_PATH = resolve('data/auth/google.json');
const REDIRECT_PORT = 53682;
const REDIRECT_URI = `http://127.0.0.1:${REDIRECT_PORT}/oauth2callback`;
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar',
];

interface StoredToken {
  refresh_token: string;
  scope?: string;
  token_type?: string;
  obtained_at: string;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`missing env var ${name}  -  copy .env.example to .env and fill it in`);
  }
  return value;
}

function buildClient(): OAuth2Client {
  const clientId = requireEnv('GOOGLE_OAUTH_CLIENT_ID');
  const clientSecret = requireEnv('GOOGLE_OAUTH_CLIENT_SECRET');
  return new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);
}

function saveToken(refreshToken: string, scope: string | undefined): void {
  mkdirSync(dirname(TOKEN_PATH), { recursive: true });
  const payload: StoredToken = {
    refresh_token: refreshToken,
    scope,
    token_type: 'Bearer',
    obtained_at: new Date().toISOString(),
  };
  writeFileSync(TOKEN_PATH, JSON.stringify(payload, null, 2), { mode: 0o600 });
  try {
    chmodSync(TOKEN_PATH, 0o600);
  } catch {
    // Windows: chmod is best-effort.
  }
}

function loadToken(): StoredToken {
  if (!existsSync(TOKEN_PATH)) {
    throw new Error(
      `no Google token at ${TOKEN_PATH}  -  run \`npm run setup:google\` first`,
    );
  }
  const raw = readFileSync(TOKEN_PATH, 'utf8');
  return JSON.parse(raw) as StoredToken;
}

export async function getAuthorizedClient(): Promise<OAuth2Client> {
  const client = buildClient();
  const stored = loadToken();
  client.setCredentials({ refresh_token: stored.refresh_token });
  return client;
}

export async function runGoogleSetup(): Promise<void> {
  const client = buildClient();
  const authUrl = client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
  });

  const code = await new Promise<string>((res, rej) => {
    const server = createServer((req, response) => {
      try {
        if (!req.url) {
          response.statusCode = 400;
          response.end('missing url');
          return;
        }
        const parsed = new URL(req.url, REDIRECT_URI);
        if (parsed.pathname !== '/oauth2callback') {
          response.statusCode = 404;
          response.end('not found');
          return;
        }
        const codeParam = parsed.searchParams.get('code');
        const errorParam = parsed.searchParams.get('error');
        if (errorParam) {
          response.statusCode = 400;
          response.end(`OAuth error: ${errorParam}`);
          server.close();
          rej(new Error(`OAuth error: ${errorParam}`));
          return;
        }
        if (!codeParam) {
          response.statusCode = 400;
          response.end('missing code');
          return;
        }
        response.statusCode = 200;
        response.setHeader('content-type', 'text/html; charset=utf-8');
        response.end(
          '<html><body><h2>auto-schedule</h2><p>Authorization complete. You can close this tab.</p></body></html>',
        );
        server.close();
        res(codeParam);
      } catch (err) {
        server.close();
        rej(err instanceof Error ? err : new Error(String(err)));
      }
    });
    server.listen(REDIRECT_PORT, '127.0.0.1', () => {
      logger.info(
        { authUrl },
        `open this URL in a browser to authorize (listening on ${REDIRECT_URI}):`,
      );
      // Print plainly too so it's easy to copy from non-TTY output.
      process.stdout.write(`\n${authUrl}\n\n`);
    });
    server.on('error', rej);
  });

  const { tokens } = await client.getToken(code);
  if (!tokens.refresh_token) {
    throw new Error(
      'no refresh_token returned  -  revoke prior consent at https://myaccount.google.com/permissions and retry',
    );
  }
  saveToken(tokens.refresh_token, tokens.scope ?? undefined);
  logger.info({ tokenPath: TOKEN_PATH }, 'google refresh token saved');
}
