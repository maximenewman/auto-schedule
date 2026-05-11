/// <reference lib="dom" />
import { createHash } from 'node:crypto';
import puppeteer, { type Browser } from 'puppeteer';
import type { Source, Subject } from '../config/subjects.js';
import type { StateStore } from '../state/store.js';
import type { AttachmentRef, SourceFetcher, SourceItem } from './types.js';
import {
  CourSysAuthError,
  attachCookies,
  loadCookies,
  validateSession,
} from '../auth/coursys.js';
import { logger } from '../logger.js';

interface ScrapedPage {
  text: string;
  attachments: AttachmentRef[];
}

export class SiteSource implements SourceFetcher {
  private browserPromise?: Promise<Browser>;

  constructor(private readonly store: StateStore) {}

  private getBrowser(): Promise<Browser> {
    if (!this.browserPromise) {
      this.browserPromise = puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      });
    }
    return this.browserPromise;
  }

  async close(): Promise<void> {
    if (this.browserPromise) {
      const b = await this.browserPromise;
      await b.close();
      this.browserPromise = undefined;
    }
  }

  async fetchNew(subject: Subject, source: Source): Promise<SourceItem[]> {
    if (source.type !== 'site') {
      throw new Error(`SiteSource called with non-site source: ${source.type}`);
    }

    const browser = await this.getBrowser();
    const page = await browser.newPage();
    try {
      const cookies = loadCookies();
      await attachCookies(page, cookies);
      await validateSession(page);

      await page.goto(source.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      // Detect a mid-session redirect to CAS too.
      const landing = new URL(page.url());
      if (landing.hostname.endsWith('sfu.ca') && /cas|sso/.test(landing.hostname)) {
        throw new CourSysAuthError(`redirected to ${landing.hostname} for ${source.url}`);
      }

      const scraped = await scrapePage(page, source.url);
      const hash = sha256(scraped.text);
      const prior = this.store.getSiteHash(subject.id, source.url);
      if (prior === hash) {
        logger.debug(
          { subjectId: subject.id, url: source.url, hash },
          'site content unchanged; skipping agent',
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
    } finally {
      await page.close();
    }
  }

  markProcessed(subject: Subject, source: Source, item: SourceItem): void {
    if (source.type !== 'site') return;
    const hash = item.meta?.contentHash;
    if (hash) {
      this.store.setSiteHash(subject.id, source.url, hash);
    }
  }
}

async function scrapePage(
  page: import('puppeteer').Page,
  baseUrl: string,
): Promise<ScrapedPage> {
  const result = await page.evaluate(() => {
    const main =
      document.querySelector('main') ??
      document.querySelector('#content') ??
      document.body;
    const text = main ? (main as HTMLElement).innerText : '';

    const seen = new Set<string>();
    const links: { href: string; text: string }[] = [];
    for (const a of Array.from(document.querySelectorAll('a[href]'))) {
      const href = (a as HTMLAnchorElement).href;
      if (!href || seen.has(href)) continue;
      seen.add(href);
      links.push({
        href,
        text: (a.textContent ?? '').trim(),
      });
    }
    return { text, links };
  });

  const text = normalize(result.text);
  const attachments: AttachmentRef[] = [];
  for (const link of result.links) {
    if (!/\.(pdf|docx?|pptx?|zip|ipynb)$/i.test(link.href)) continue;
    let absolute: string;
    try {
      absolute = new URL(link.href, baseUrl).toString();
    } catch {
      continue;
    }
    const filenameMatch = absolute.match(/\/([^/?#]+)(?:[?#]|$)/);
    const filename = filenameMatch?.[1] ?? link.text ?? 'attachment';
    attachments.push({
      url: absolute,
      filename: decodeURIComponent(filename),
      meta: { sourceHost: new URL(absolute).hostname },
    });
  }
  return { text, attachments };
}

function normalize(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/\s+$/g, '').trimEnd())
    .map((line) => line.replace(/[ \t]{2,}/g, ' '))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}
