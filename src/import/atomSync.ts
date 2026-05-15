import { loadSubjects, type Subject } from '../config/subjectsStore.js';
import type { StateStore } from '../state/store.js';
import { parseAtom, type AtomEntry } from '../sources/atomParser.js';
import { logger } from '../logger.js';

export const ATOM_URL_SETTING = 'coursys.atom_url';

const COURSE_CODE_RE = /^([A-Z]{2,4})\s*(\d{2,3}[A-Z]?)$/;

export type AtomProgress =
  | { stage: 'fetch'; status: 'start' }
  | { stage: 'fetch'; status: 'done'; fetched: number }
  | { stage: 'persist'; status: 'start'; total: number }
  | { stage: 'persist'; status: 'tick'; processed: number; total: number }
  | { stage: 'persist'; status: 'done'; inserted: number; updated: number; unattributed: number }
  | { stage: 'done'; result: AtomSyncResult }
  | { stage: 'error'; message: string };

export interface AtomSyncResult {
  fetched: number;
  inserted: number;
  updated: number;
  /** Entries without a recognisable `<category term="CMPT 307">` — kept in
   *  the DB anyway with subjectId = null. */
  unattributed: number;
  /** Entries we skipped entirely (no id, malformed). */
  skipped: number;
}

export interface AtomSyncOptions {
  googleAuth?: unknown; // unused today — kept symmetric with iCal sync
  store: StateStore;
  userId?: number;
}

/**
 * Fetch the CourSys Atom feed and store every entry in `announcements`.
 * Pure persistence — does not invoke the LLM extractor. A later pass picks
 * up `extract_status = 'pending'` rows and feeds them to extractEvents.
 */
export async function syncAtomSubscription(
  url: string,
  opts: AtomSyncOptions,
  onProgress?: (e: AtomProgress) => void,
): Promise<AtomSyncResult> {
  const result: AtomSyncResult = {
    fetched: 0,
    inserted: 0,
    updated: 0,
    unattributed: 0,
    skipped: 0,
  };

  onProgress?.({ stage: 'fetch', status: 'start' });
  const xml = await fetchAtom(url);
  const feed = parseAtom(xml);
  result.fetched = feed.entries.length;
  logger.info(
    { url, count: feed.entries.length, title: feed.title },
    'atom: fetched',
  );
  onProgress?.({ stage: 'fetch', status: 'done', fetched: feed.entries.length });

  // Subject attribution: normalise each subject's id/code so an Atom
  // `<category term="CMPT 307">` lines up with a `cmpt307` subject id.
  const subjects = await loadSubjects(opts.store, opts.userId);
  const subjectByCode = new Map<string, Subject>();
  for (const s of subjects) {
    subjectByCode.set(normCode(s.id), s);
    if (s.code) subjectByCode.set(normCode(s.code), s);
  }

  onProgress?.({ stage: 'persist', status: 'start', total: feed.entries.length });
  let processed = 0;
  const tickEvery = Math.max(1, Math.floor(feed.entries.length / 20));
  for (const entry of feed.entries) {
    if (!entry.id) {
      result.skipped++;
      processed++;
      continue;
    }
    const courseCode = pickCourseCode(entry);
    const subject = courseCode ? subjectByCode.get(normCode(courseCode)) : undefined;
    if (!subject) result.unattributed++;

    try {
      const r = await opts.store.upsertAnnouncement(
        {
          entryId: entry.id,
          subjectId: subject?.id ?? null,
          courseCode,
          title: entry.title,
          contentHtml: entry.contentHtml,
          link: entry.link,
          author: entry.author,
          publishedAt: entry.publishedISO || null,
          updatedAt: entry.updatedISO || null,
        },
        opts.userId,
      );
      if (r.inserted) result.inserted++;
      else result.updated++;
    } catch (err) {
      logger.error({ err, entryId: entry.id }, 'atom: upsert failed');
    }
    processed++;
    if (processed % tickEvery === 0 || processed === feed.entries.length) {
      onProgress?.({
        stage: 'persist',
        status: 'tick',
        processed,
        total: feed.entries.length,
      });
    }
  }
  onProgress?.({
    stage: 'persist',
    status: 'done',
    inserted: result.inserted,
    updated: result.updated,
    unattributed: result.unattributed,
  });
  onProgress?.({ stage: 'done', result });
  logger.info(result, 'atom: sync finished');
  return result;
}

async function fetchAtom(url: string): Promise<string> {
  // Same content-negotiation trick as the iCal feed: the URL has no
  // extension, the server picks the format from Accept.
  const res = await fetch(url, {
    redirect: 'follow',
    headers: {
      Accept: 'application/atom+xml, application/xml;q=0.5, text/xml;q=0.4, */*;q=0.1',
      'User-Agent': 'auto-schedule/1.0 (+https://github.com/maximenewman/auto-schedule)',
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `atom fetch failed: HTTP ${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 200)}` : ''}`,
    );
  }
  const text = await res.text();
  if (!/<\s*feed\b/i.test(text)) {
    const ct = res.headers.get('content-type') ?? 'unknown';
    throw new Error(
      `atom response is not an Atom feed (content-type: ${ct}). Double-check the URL — it should be the personal CourSys news token URL.`,
    );
  }
  return text;
}

function pickCourseCode(entry: AtomEntry): string | null {
  for (const c of entry.categories) {
    const m = COURSE_CODE_RE.exec(c.trim());
    if (m) return `${m[1]} ${m[2]}`;
  }
  // Fallback: try to recover the code from the link or title — CourSys
  // links look like `…/2026su-cmpt-307-d1/news/42/`.
  const fromLink = entry.link?.match(/\/\d{4}[a-z]{2}-([a-z]{2,4})-(\d{2,3}[a-z]?)-/i);
  if (fromLink) return `${fromLink[1]!.toUpperCase()} ${fromLink[2]!.toUpperCase()}`;
  const fromTitle = entry.title.match(/\b([A-Z]{2,4})\s+(\d{2,3}[A-Z]?)\b/);
  if (fromTitle) return `${fromTitle[1]} ${fromTitle[2]}`;
  return null;
}

function normCode(s: string): string {
  return s.replace(/\s+/g, '').toUpperCase();
}
