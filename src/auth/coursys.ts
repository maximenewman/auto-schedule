import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import puppeteer, { type Browser, type Cookie, type Page } from 'puppeteer';
import { logger } from '../logger.js';

const COOKIE_PATH = resolve('data/auth/coursys.json');
const HOME_URL = 'https://coursys.sfu.ca/';
const VALIDATE_URL = 'https://coursys.sfu.ca/';
const LOGIN_HOSTS = ['cas.sfu.ca', 'sso.sfu.ca'];

export class CourSysAuthError extends Error {
  constructor(message = 'CourSys session expired') {
    super(message);
    this.name = 'CourSysAuthError';
  }
}

interface StoredCookies {
  cookies: Cookie[];
  saved_at: string;
}

export function loadCookies(): Cookie[] {
  if (!existsSync(COOKIE_PATH)) {
    throw new CourSysAuthError(
      `no CourSys cookies at ${COOKIE_PATH} — run \`npm run setup:coursys\``,
    );
  }
  const parsed = JSON.parse(readFileSync(COOKIE_PATH, 'utf8')) as StoredCookies;
  return parsed.cookies;
}

export function saveCookies(cookies: Cookie[]): void {
  mkdirSync(dirname(COOKIE_PATH), { recursive: true });
  const payload: StoredCookies = { cookies, saved_at: new Date().toISOString() };
  writeFileSync(COOKIE_PATH, JSON.stringify(payload, null, 2), { mode: 0o600 });
  try {
    chmodSync(COOKIE_PATH, 0o600);
  } catch {
    // Windows: chmod is best-effort.
  }
}

export async function attachCookies(page: Page, cookies: Cookie[]): Promise<void> {
  if (cookies.length === 0) return;
  await page.browser().setCookie(...cookies);
}

/**
 * Visits a CourSys URL with the stored cookies. If we end up redirected to CAS
 * the session is dead; throw CourSysAuthError so the orchestrator can route to
 * the notifier and stop the pipeline.
 */
export async function validateSession(page: Page): Promise<void> {
  await page.goto(VALIDATE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  const finalUrl = new URL(page.url());
  if (LOGIN_HOSTS.includes(finalUrl.hostname)) {
    throw new CourSysAuthError(
      `CourSys redirected to ${finalUrl.hostname} — re-auth required`,
    );
  }
}

export async function runCourSysSetup(): Promise<void> {
  const browser: Browser = await puppeteer.launch({
    headless: false,
    defaultViewport: null,
    args: ['--start-maximized'],
  });
  try {
    const page = await browser.newPage();
    logger.info(
      `opening ${HOME_URL} — log in via CAS, then return here. Cookies will be captured automatically.`,
    );
    await page.goto(HOME_URL, { waitUntil: 'domcontentloaded' });

    // Poll until we're back on coursys.sfu.ca with a session-like cookie set;
    // CAS hops through several redirects, so a single navigation isn't reliable.
    const deadline = Date.now() + 5 * 60 * 1000;
    while (Date.now() < deadline) {
      const url = new URL(page.url());
      const cookies = await page.browser().cookies();
      const hasSession = cookies.some(
        (c) => c.domain.includes('coursys.sfu.ca') && /session/i.test(c.name),
      );
      if (url.hostname === 'coursys.sfu.ca' && hasSession) break;
      await new Promise((r) => setTimeout(r, 1500));
    }

    const cookies = await page.browser().cookies();
    const coursysCookies = cookies.filter((c) => c.domain.includes('coursys.sfu.ca'));
    if (coursysCookies.length === 0) {
      throw new Error('no coursys.sfu.ca cookies captured — login may not have completed');
    }
    saveCookies(coursysCookies);
    logger.info(
      { cookieCount: coursysCookies.length, cookiePath: COOKIE_PATH },
      'coursys cookies saved',
    );
  } finally {
    await browser.close();
  }
}
