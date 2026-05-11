import type { OAuth2Client } from 'google-auth-library';
import type { Source, Subject } from './config/subjects.js';
import type { StateStore } from './state/store.js';
import { getFetcher } from './sources/factory.js';
import { extractEvents } from './agent/extractor.js';
import { upsertEvent } from './sync/calendar.js';
import { logger } from './logger.js';

export interface RunContext {
  googleAuth: OAuth2Client;
  store: StateStore;
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

  for (const subject of subjects) {
    summary.subjectsProcessed++;
    const subjectLog = logger.child({ subjectId: subject.id });
    for (const source of subject.sources) {
      summary.sourcesProcessed++;
      try {
        const events = await processSource(subject, source, ctx);
        summary.itemsProcessed += events.items;
        summary.eventsUpserted += events.upserted;
      } catch (err) {
        summary.failures++;
        subjectLog.error({ err, source }, 'source failed');
      }
    }
  }

  logger.info(summary, 'pipeline finished');
  return summary;
}

async function processSource(
  subject: Subject,
  source: Source,
  ctx: RunContext,
): Promise<{ items: number; upserted: number }> {
  const fetcher = getFetcher(source, ctx);
  const items = await fetcher.fetchNew(subject, source);
  let upserted = 0;

  for (const item of items) {
    const log = logger.child({
      subjectId: subject.id,
      sourceType: source.type,
      sourceItemId: item.sourceItemId,
    });

    const extracted = await extractEvents(subject, source, item.content);
    if (!extracted) {
      log.warn('agent returned no object; skipping item (raw output logged)');
      continue;
    }

    if (extracted.events.length === 0) {
      log.info('agent emitted no events for this item');
    }

    for (const event of extracted.events) {
      try {
        await upsertEvent(ctx.googleAuth, subject.id, event, ctx.store);
        upserted++;
      } catch (err) {
        log.error({ err, itemId: event.itemId }, 'calendar upsert failed');
      }
    }

    // Mark processed AFTER calendar upserts so a failure mid-loop re-runs cleanly.
    fetcher.markProcessed(subject, source, item);
  }

  return { items: items.length, upserted };
}
