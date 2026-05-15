import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import type { Source, Subject } from '../config/subjects.js';
import type { StateStore } from '../state/store.js';
import type { AttachmentRef, SourceFetcher, SourceItem } from './types.js';
import { CourSysAuthError, loadCookies } from '../auth/coursys.js';
import { logger } from '../logger.js';

const CAS_HOST_RE = /(?:^|\.)(?:cas|sso)\.sfu\.ca$/;
const ATTACHMENT_EXT_RE = /\.(pdf|docx?|pptx?|zip|ipynb)$/i;

interface ScrapedPage {
  text: string;
  attachments: AttachmentRef[];
}

export class SiteSource implements SourceFetcher {
  constructor(
    private readonly store: StateStore,
    private readonly userId?: number,
  ) {}

  async close(): Promise<void> {
    // Nothing to clean up — fetch is stateless. Kept for API compatibility
    // with the previous puppeteer-backed implementation.
  }

  async fetchNew(subject: Subject, source: Source): Promise<SourceItem[]> {
    if (source.type !== 'site') {
      throw new Error(`SiteSource called with non-site source: ${source.type}`);
    }

    const cookies = await loadCookies(this.store, this.userId);
    const cookieHeader = buildCookieHeader(cookies);

    logger.info({ subjectId: subject.id, url: source.url }, 'site: fetching');
    const html = await fetchHtml(source.url, cookieHeader);

    const scraped = scrapeHtml(html, source.url);
    const hash = sha256(scraped.text);
    const prior = await this.store.getSiteHash(subject.id, source.url, this.userId);
    logger.info(
      {
        subjectId: subject.id,
        url: source.url,
        chars: scraped.text.length,
        attachments: scraped.attachments.length,
        hash: hash.slice(0, 12),
      },
      'site: scraped',
    );
    if (prior === hash) {
      logger.info(
        { subjectId: subject.id, url: source.url },
        'site: content unchanged  -  skipping agent',
      );
      return [];
    }

    return [
      {
        sourceItemId: source.url,
        content: scraped.text,
        attachments: scraped.attachments,
        meta: { url: source.url, contentHash: hash },
      },
    ];
  }

  async markProcessed(subject: Subject, source: Source, item: SourceItem): Promise<void> {
    if (source.type !== 'site') return;
    const hash = item.meta?.contentHash;
    if (hash) {
      await this.store.setSiteHash(subject.id, source.url, hash, this.userId);
    }
  }
}

interface StoredCookie {
  name: string;
  value: string;
  domain?: string;
}

function buildCookieHeader(cookies: StoredCookie[]): string {
  // We don't filter by domain here — every cookie the user has saved goes on
  // every request. CourSys auth scatters cookies across coursys.sfu.ca and
  // cas.sfu.ca; both are reached during the redirect dance, so sending all
  // of them is safer than trying to second-guess the auth flow.
  return cookies
    .filter((c) => c.name && c.value)
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
}

async function fetchHtml(url: string, cookieHeader: string): Promise<string> {
  const res = await fetch(url, {
    redirect: 'follow',
    headers: {
      cookie: cookieHeader,
      // Some SFU pages serve a different (login-wall) variant to unknown UAs;
      // claim a real browser so the cookie-based path stays open.
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      accept: 'text/html,application/xhtml+xml',
    },
  });
  // If the redirect chain landed us on CAS/SSO, the cookies are stale.
  const finalUrl = new URL(res.url);
  if (CAS_HOST_RE.test(finalUrl.hostname)) {
    throw new CourSysAuthError(
      `redirected to ${finalUrl.hostname} for ${url}`,
    );
  }
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new CourSysAuthError(`HTTP ${res.status} on ${url}`);
    }
    throw new Error(`site fetch failed: HTTP ${res.status} ${res.statusText} ${url}`);
  }
  return await res.text();
}

function scrapeHtml(html: string, baseUrl: string): ScrapedPage {
  const $ = cheerio.load(html);

  // Drop content that would only noise up the text payload sent to the
  // agent (scripts, styles, nav chrome). cheerio's remove() is mutating.
  $('script, style, noscript').remove();

  // Mirror the puppeteer code's preference: pick the most-likely "content"
  // block; fall back to body. innerText-equivalent normalisation happens
  // in normalizeText().
  const main = $('main').first();
  const content = main.length ? main : $('#content').first();
  const root = content.length ? content : $('body');
  const rawText = root.text();
  const text = normalizeText(rawText);

  const seen = new Set<string>();
  const attachments: AttachmentRef[] = [];
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    let absolute: string;
    try {
      absolute = new URL(href, baseUrl).toString();
    } catch {
      return;
    }
    if (seen.has(absolute)) return;
    seen.add(absolute);
    if (!ATTACHMENT_EXT_RE.test(absolute)) return;
    const filenameMatch = absolute.match(/\/([^/?#]+)(?:[?#]|$)/);
    const filename = (filenameMatch?.[1] ?? $(el).text().trim()) || 'attachment';
    attachments.push({
      url: absolute,
      filename: decodeURIComponent(filename),
      meta: { sourceHost: new URL(absolute).hostname },
    });
  });

  return { text, attachments };
}

function normalizeText(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}
