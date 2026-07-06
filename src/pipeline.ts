import type { OAuth2Client } from 'google-auth-library';
import type { StateStore } from './state/store.js';
import { runFullIcalSync, ICAL_URL_SETTING } from './import/icalSync.js';
import { syncAtomSubscription, ATOM_URL_SETTING } from './import/atomSync.js';
import { syncCanvas } from './import/canvasSync.js';
import { extractPendingAnnouncements } from './import/announcementExtract.js';
import { logger } from './logger.js';

export interface RunContext {
  /** null = user has no Google Calendar connected; local rows only. */
  googleAuth: OAuth2Client | null;
  store: StateStore;
  userId?: number;
}

export interface RunSummary {
  canvasEventsWritten: number;
  icalEventsUpserted: number;
  announcementsFetched: number;
  announcementsExtracted: number;
  eventsFromAnnouncements: number;
  failures: number;
}

/**
 * Full ingestion for one user, in dependency order:
 *   1. Canvas (primary): courses -> subjects, announcements, structured events
 *   2. CourSys iCal feed (secondary): lectures/labs/deadlines
 *   3. CourSys Atom feed (secondary): announcements
 *   4. LLM pass over pending announcements -> events
 * Each stage is fail-soft: an error is counted and logged, and the run moves
 * on to the next stage.
 */
export async function runPipeline(ctx: RunContext): Promise<RunSummary> {
  const summary: RunSummary = {
    canvasEventsWritten: 0,
    icalEventsUpserted: 0,
    announcementsFetched: 0,
    announcementsExtracted: 0,
    eventsFromAnnouncements: 0,
    failures: 0,
  };

  // 1. Canvas — primary source. Missing token just means the stage is skipped.
  const canvasToken = await ctx.store.getCanvasToken(ctx.userId);
  if (canvasToken) {
    try {
      const r = await syncCanvas({
        store: ctx.store,
        userId: ctx.userId,
        googleAuth: ctx.googleAuth,
      });
      summary.canvasEventsWritten = r.eventsWritten;
      summary.announcementsFetched += r.announcementsFetched;
      summary.failures += r.eventFailures + r.fileFailures;
    } catch (err) {
      summary.failures++;
      logger.error({ err, userId: ctx.userId }, 'pipeline: canvas sync failed');
    }
  } else {
    logger.info({ userId: ctx.userId }, 'pipeline: no canvas token — skipping');
  }

  // 2. CourSys iCal subscription.
  const icalUrl = await ctx.store.getSetting(ICAL_URL_SETTING, ctx.userId);
  if (icalUrl) {
    try {
      const r = await runFullIcalSync(icalUrl, {
        googleAuth: ctx.googleAuth,
        store: ctx.store,
        userId: ctx.userId,
      });
      summary.icalEventsUpserted = r.eventsInserted + r.eventsUpdated;
      summary.failures += r.failures;
    } catch (err) {
      summary.failures++;
      logger.error({ err, userId: ctx.userId }, 'pipeline: ical sync failed');
    }
  } else {
    logger.info({ userId: ctx.userId }, 'pipeline: no iCal URL — skipping');
  }

  // 3. CourSys Atom news feed.
  const atomUrl = await ctx.store.getSetting(ATOM_URL_SETTING, ctx.userId);
  if (atomUrl) {
    try {
      const r = await syncAtomSubscription(atomUrl, {
        store: ctx.store,
        userId: ctx.userId,
      });
      summary.announcementsFetched += r.fetched;
    } catch (err) {
      summary.failures++;
      logger.error({ err, userId: ctx.userId }, 'pipeline: atom sync failed');
    }
  } else {
    logger.info({ userId: ctx.userId }, 'pipeline: no Atom URL — skipping');
  }

  // 4. LLM extraction over whatever announcements are now pending.
  try {
    const r = await extractPendingAnnouncements({
      store: ctx.store,
      userId: ctx.userId,
      googleAuth: ctx.googleAuth,
    });
    summary.announcementsExtracted = r.extracted;
    summary.eventsFromAnnouncements = r.eventsWritten;
    summary.failures += r.failures;
  } catch (err) {
    summary.failures++;
    logger.error({ err, userId: ctx.userId }, 'pipeline: announcement extraction failed');
  }

  logger.info(summary, 'pipeline finished');
  return summary;
}
