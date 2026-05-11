import type { OAuth2Client } from 'google-auth-library';
import type { Source, Subject } from './config/subjects.js';
import type { StateStore } from './state/store.js';
import { FetcherRegistry } from './sources/factory.js';
import { extractEvents } from './agent/extractor.js';
import { upsertEvent } from './sync/calendar.js';
import { downloadAttachment } from './sync/files.js';
import { logger } from './logger.js';
import { CourSysAuthError } from './auth/coursys.js';

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
  const registry = new FetcherRegistry(ctx);

  try {
    for (const subject of subjects) {
      summary.subjectsProcessed++;
      const subjectLog = logger.child({ subjectId: subject.id });
      for (const source of subject.sources) {
        summary.sourcesProcessed++;
        try {
          const events = await processSource(subject, source, registry, ctx);
          summary.itemsProcessed += events.items;
          summary.eventsUpserted += events.upserted;
        } catch (err) {
          summary.failures++;
          if (err instanceof CourSysAuthError) {
            subjectLog.error({ err: err.message, source }, 'coursys auth failed — bailing out');
            throw err;
          }
          subjectLog.error({ err, source }, 'source failed');
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

      for (const attachment of event.attachments) {
        await downloadAttachment(attachment, subject.destinationFolder, {
          googleAuth: ctx.googleAuth,
          store: ctx.store,
        });
      }
    }

    // Source-level attachments (e.g. files referenced in an email or page but
    // not pulled into a specific event) — best-effort download too.
    for (const attachment of item.attachments) {
      await downloadAttachment(attachment, subject.destinationFolder, {
        googleAuth: ctx.googleAuth,
        store: ctx.store,
      });
    }

    // Mark processed AFTER calendar upserts so a failure mid-loop re-runs cleanly.
    fetcher.markProcessed(subject, source, item);
  }

  return { items: items.length, upserted };
}
