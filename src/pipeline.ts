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
      subjectLog.info(
        { name: subject.name, sources: subject.sources.length },
        `→ subject ${subject.name}`,
      );
      for (const source of subject.sources) {
        summary.sourcesProcessed++;
        const label = describeSource(source);
        subjectLog.info({ source: label }, `  → source ${label}`);
        try {
          const events = await processSource(subject, source, registry, ctx);
          summary.itemsProcessed += events.items;
          summary.eventsUpserted += events.upserted;
          subjectLog.info(
            { source: label, items: events.items, upserted: events.upserted },
            `    ✓ source done`,
          );
        } catch (err) {
          summary.failures++;
          if (err instanceof CourSysAuthError) {
            subjectLog.error(
              { err: err.message, source: label },
              'coursys auth failed — bailing out',
            );
            throw err;
          }
          subjectLog.error({ err, source: label }, '    ✗ source failed');
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
      '    (no new items — skipping agent)',
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
      '      → asking agent to extract events',
    );
    const extracted = await extractEvents(subject, source, item.content, {
      store: ctx.store,
    });
    if (!extracted) {
      log.warn('      ✗ agent returned no object; skipping item (raw output logged)');
      continue;
    }
    log.info({ events: extracted.events.length }, '      ← agent emitted events');

    for (const event of extracted.events) {
      try {
        await upsertEvent(
          ctx.googleAuth,
          subject.id,
          event,
          ctx.store,
          describeSource(source),
        );
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

function describeSource(source: Source): string {
  return source.type === 'email' ? `email:${source.label}` : `site:${source.url}`;
}
