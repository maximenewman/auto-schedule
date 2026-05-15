import type { OAuth2Client } from 'google-auth-library';
import type { Source, Subject } from './config/subjects.js';
import type { StateStore } from './state/store.js';
import { FetcherRegistry } from './sources/factory.js';
import { extractEvents } from './agent/extractor.js';
import { upsertEvent } from './sync/calendar.js';
import { logger } from './logger.js';
import { CourSysAuthError } from './auth/coursys.js';
import { runFullIcalSync, ICAL_URL_SETTING } from './import/icalSync.js';

export interface RunContext {
  googleAuth: OAuth2Client;
  store: StateStore;
  userId?: number;
}

export interface RunSummary {
  subjectsProcessed: number;
  sourcesProcessed: number;
  itemsProcessed: number;
  eventsUpserted: number;
  failures: number;
}

export async function runPipeline(
  subjects: Subject[],
  ctx: RunContext,
): Promise<RunSummary> {
  const summary: RunSummary = {
    subjectsProcessed: 0,
    sourcesProcessed: 0,
    itemsProcessed: 0,
    eventsUpserted: 0,
    failures: 0,
  };
  const registry = new FetcherRegistry(ctx);

  // iCal subscription is the default ingestion path  -  if a global CourSys
  // iCal URL is saved, sync it first so any auto-created subjects exist
  // before the per-subject email/site loop runs.
  const icalUrl = await ctx.store.getSetting(ICAL_URL_SETTING, ctx.userId);
  if (icalUrl) {
    try {
      const r = await runFullIcalSync(icalUrl, {
        googleAuth: ctx.googleAuth,
        store: ctx.store,
        userId: ctx.userId,
      });
      summary.eventsUpserted += r.eventsInserted + r.eventsUpdated;
      summary.itemsProcessed += r.fetched;
      summary.failures += r.failures;
    } catch (err) {
      summary.failures++;
      logger.error({ err }, 'ical: sync failed  -  continuing with per-subject sources');
    }
  } else {
    logger.info('ical: no URL configured  -  skipping');
  }

  try {
    for (const subject of subjects) {
      summary.subjectsProcessed++;
      const subjectLog = logger.child({ subjectId: subject.id });
      subjectLog.info(
        { name: subject.name, sources: subject.sources.length },
        `-> subject ${subject.name}`,
      );
      for (const source of subject.sources) {
        summary.sourcesProcessed++;
        const label = describeSource(source);
        subjectLog.info({ source: label }, `  -> source ${label}`);
        try {
          const events = await processSource(subject, source, registry, ctx);
          summary.itemsProcessed += events.items;
          summary.eventsUpserted += events.upserted;
          subjectLog.info(
            { source: label, items: events.items, upserted: events.upserted },
            `    + source done`,
          );
        } catch (err) {
          summary.failures++;
          if (err instanceof CourSysAuthError) {
            subjectLog.error(
              { err: err.message, source: label },
              'coursys auth failed  -  bailing out',
            );
            throw err;
          }
          subjectLog.error({ err, source: label }, '    x source failed');
        }
      }
    }
  } finally {
    await registry.close();
  }

  logger.info(summary, 'pipeline finished');
  return summary;
}

async function processSource(
  subject: Subject,
  source: Source,
  registry: FetcherRegistry,
  ctx: RunContext,
): Promise<{ items: number; upserted: number }> {
  const fetcher = registry.get(source);
  const items = await fetcher.fetchNew(subject, source);
  if (items.length === 0) {
    logger.info(
      { subjectId: subject.id, source: describeSource(source) },
      '    (no new items  -  skipping agent)',
    );
  }
  let upserted = 0;

  for (const item of items) {
    const log = logger.child({
      subjectId: subject.id,
      sourceType: source.type,
      sourceItemId: item.sourceItemId,
    });

    log.info(
      { contentChars: item.content.length, attachments: item.attachments.length },
      '      -> asking agent to extract events',
    );
    const extracted = await extractEvents(subject, source, item.content, {
      store: ctx.store,
      userId: ctx.userId,
    });
    if (!extracted) {
      log.warn('      x agent returned no object; skipping item (raw output logged)');
      continue;
    }
    log.info({ events: extracted.events.length }, '      <- agent emitted events');

    for (const event of extracted.events) {
      try {
        await upsertEvent(
          ctx.googleAuth,
          subject.id,
          event,
          ctx.store,
          describeSource(source),
          ctx.userId,
        );
        upserted++;
      } catch (err) {
        log.error({ err, itemId: event.itemId }, 'calendar upsert failed');
      }
    }

    // Attachments used to be downloaded to subject.destinationFolder here.
    // Phase D removed that path; attachment URLs travel with the calendar
    // event (in the description) so the user can click through from Google
    // Calendar instead.

    // Mark processed AFTER calendar upserts so a failure mid-loop re-runs cleanly.
    await fetcher.markProcessed(subject, source, item);
  }

  return { items: items.length, upserted };
}

function describeSource(source: Source): string {
  return source.type === 'email' ? `email:${source.label}` : `site:${source.url}`;
}
