import {
  generateText,
  tool,
  Output,
  NoObjectGeneratedError,
  APICallError,
} from 'ai';
import { createOpenAI, type OpenAIProvider } from '@ai-sdk/openai';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { Source, Subject } from '../config/subjects.js';
import { CalendarEventListSchema, type CalendarEventList } from './schema.js';
import { SYSTEM_PROMPT } from './prompt.js';
import { sanitizeEventId } from '../sync/calendar.js';
import type { StateStore } from '../state/store.js';
import { logger } from '../logger.js';

const DEFAULT_MODEL = process.env.AGENT_MODEL ?? 'openai/gpt-4o-mini';
const ERROR_DIR = resolve('logs/agent-errors');

let cachedProvider: OpenAIProvider | undefined;

function getProvider(): OpenAIProvider {
  if (cachedProvider) return cachedProvider;
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error('missing env var OPENROUTER_API_KEY');
  }
  cachedProvider = createOpenAI({
    apiKey,
    baseURL: 'https://openrouter.ai/api/v1',
    headers: {
      'HTTP-Referer': 'https://github.com/maximenewman/auto-schedule',
      'X-Title': 'auto-schedule',
    },
  });
  return cachedProvider;
}

export interface ExtractContext {
  store?: StateStore;
}

export async function extractEvents(
  subject: Subject,
  source: Source,
  content: string,
  ctx: ExtractContext = {},
): Promise<CalendarEventList | null> {
  const start = Date.now();
  try {
    const result = await generateText({
      model: getProvider()(DEFAULT_MODEL),
      temperature: 0.2,
      // The agent uses one or two tool roundtrips to check existing events.
      // 4 steps leaves slack for a lookup + an emit + a retry.
      maxSteps: 4,
      // 2000 fits even verbose syllabi with room to spare.
      maxTokens: 2000,
      system: SYSTEM_PROMPT,
      prompt: [
        `Subject: ${subject.name} (id=${subject.id})`,
        `Professor: ${subject.professor}`,
        `Source type: ${source.type}`,
        '',
        'Content:',
        content,
      ].join('\n'),
      tools: {
        lookup_calendar_event: tool({
          description:
            "Look up an existing Google Calendar event for this subject by stable itemId. " +
            "Returns { exists, summary, description, room, startISO, endISO }  -  call this BEFORE emitting an event to check whether the user already has data for it. " +
            "When an existing event has a non-empty value for a field, prefer to omit your value (it won't be overwritten)  -  that way handwritten edits are preserved.",
          parameters: z.object({
            itemId: z
              .string()
              .describe(
                "The stable itemId you would assign to this event, e.g. 'a3', 'midterm-1', 'lec-d100-tue-1430-2026-05-12'.",
              ),
          }),
          execute: async ({ itemId }) => {
            if (!ctx.store) return { exists: false, itemId };
            const eventId = sanitizeEventId(subject.id, itemId);
            const items = await ctx.store.listCalendarItems({ subjectId: subject.id });
            const found = items.find((i) => i.eventId === eventId || i.itemId === itemId);
            if (!found) return { exists: false, itemId };
            return {
              exists: true,
              itemId,
              summary: found.summary || null,
              description: found.description || null,
              room: found.room,
              startISO: found.startISO,
              endISO: found.endISO,
            };
          },
        }),
      },
      experimental_output: Output.object({ schema: CalendarEventListSchema }),
    });

    const data = result.experimental_output as CalendarEventList | undefined;
    logger.info(
      {
        subjectId: subject.id,
        model: DEFAULT_MODEL,
        ms: Date.now() - start,
        promptTokens: result.usage?.promptTokens,
        completionTokens: result.usage?.completionTokens,
        steps: result.steps?.length,
        toolCalls: result.steps?.reduce((n, s) => n + s.toolCalls.length, 0),
        events: data?.events.length ?? 0,
      },
      'agent: extracted',
    );
    return data ?? null;
  } catch (err) {
    const raw = NoObjectGeneratedError.isInstance(err) ? err.text : undefined;
    logRawFailure(subject, source, content, err, raw);
    return null;
  }
}

function describeError(err: unknown): Record<string, unknown> {
  if (APICallError.isInstance(err)) {
    return {
      kind: 'APICallError',
      message: err.message,
      statusCode: err.statusCode,
      url: err.url,
      responseBody: err.responseBody,
      responseHeaders: err.responseHeaders,
      isRetryable: err.isRetryable,
      data: err.data,
    };
  }
  if (NoObjectGeneratedError.isInstance(err)) {
    return {
      kind: 'NoObjectGeneratedError',
      message: err.message,
      text: err.text,
      cause: err.cause instanceof Error ? err.cause.message : String(err.cause ?? ''),
    };
  }
  if (err instanceof Error) {
    return {
      kind: err.name,
      message: err.message,
      stack: err.stack,
      cause: err.cause instanceof Error ? err.cause.message : err.cause,
    };
  }
  return { kind: 'unknown', value: String(err) };
}

function logRawFailure(
  subject: Subject,
  source: Source,
  content: string,
  err: unknown,
  raw: string | undefined,
): void {
  mkdirSync(ERROR_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const slug = source.type === 'email' ? source.label : source.url;
  const safeSlug = slug.replace(/[^a-z0-9-]/gi, '_').slice(0, 80);
  const file = resolve(
    ERROR_DIR,
    `${stamp}__${subject.id}__${safeSlug}.json`,
  );
  const details = describeError(err);
  writeFileSync(
    file,
    JSON.stringify(
      {
        when: new Date().toISOString(),
        subjectId: subject.id,
        source,
        error: details,
        rawModelOutput: raw,
        inputContent: content,
      },
      null,
      2,
    ),
  );
  logger.error(
    { file, subjectId: subject.id, errorKind: details.kind, statusCode: details.statusCode },
    'agent extraction failed; raw output logged',
  );
}
