import type { OAuth2Client } from 'google-auth-library';
import { findSubject } from '../config/subjectsStore.js';
import type { StateStore } from '../state/store.js';
import { extractEvents } from '../agent/extractor.js';
import { writeEvent } from '../sync/calendar.js';
import { logger } from '../logger.js';

export interface ExtractRunOptions {
  store: StateStore;
  userId?: number;
  /** null = user has no Google Calendar connected; local rows only. */
  googleAuth: OAuth2Client | null;
  /** Max announcements to process this run — keeps LLM cost bounded. */
  limit?: number;
}

export interface ExtractRunResult {
  processed: number;
  extracted: number;
  skipped: number;
  eventsWritten: number;
  failures: number;
}

/**
 * The deferred LLM pass: walk announcements with extract_status='pending',
 * run each through the event extractor, and write whatever events it finds.
 * Announcements without an attributed subject are marked 'skipped' — there's
 * no subject card to hang events on.
 */
export async function extractPendingAnnouncements(
  opts: ExtractRunOptions,
): Promise<ExtractRunResult> {
  const result: ExtractRunResult = {
    processed: 0,
    extracted: 0,
    skipped: 0,
    eventsWritten: 0,
    failures: 0,
  };

  const pending = await opts.store.listPendingAnnouncements(opts.limit ?? 25, opts.userId);
  for (const ann of pending) {
    result.processed++;
    if (!ann.subjectId) {
      await opts.store.setAnnouncementExtractStatus(ann.entryId, 'skipped', opts.userId);
      result.skipped++;
      continue;
    }
    const subject = await findSubject(opts.store, ann.subjectId, opts.userId);
    if (!subject) {
      await opts.store.setAnnouncementExtractStatus(ann.entryId, 'skipped', opts.userId);
      result.skipped++;
      continue;
    }

    const content = [
      `Announcement: ${ann.title}`,
      ann.publishedAt ? `Posted: ${ann.publishedAt}` : null,
      ann.author ? `Author: ${ann.author}` : null,
      '',
      stripHtml(ann.contentHtml),
    ]
      .filter((l) => l !== null)
      .join('\n');

    try {
      const extracted = await extractEvents(
        subject,
        { type: 'announcement', label: ann.entryId },
        content,
        { store: opts.store, userId: opts.userId },
      );
      if (!extracted) {
        // Extractor already dumped the raw failure; leave the row pending so
        // the next run retries it.
        result.failures++;
        continue;
      }
      for (const event of extracted.events) {
        try {
          await writeEvent(
            opts.googleAuth,
            subject.id,
            event,
            opts.store,
            `announcement:${ann.entryId}`,
            opts.userId,
          );
          result.eventsWritten++;
        } catch (err) {
          result.failures++;
          logger.error({ err, itemId: event.itemId }, 'announcement: event write failed');
        }
      }
      await opts.store.setAnnouncementExtractStatus(ann.entryId, 'extracted', opts.userId);
      result.extracted++;
    } catch (err) {
      result.failures++;
      logger.error({ err, entryId: ann.entryId }, 'announcement: extraction failed');
    }
  }

  if (result.processed > 0) logger.info(result, 'announcements: extract pass finished');
  return result;
}

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
