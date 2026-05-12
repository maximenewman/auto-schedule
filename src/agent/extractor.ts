import { generateObject, NoObjectGeneratedError, APICallError } from 'ai';
import { createOpenAI, type OpenAIProvider } from '@ai-sdk/openai';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Source, Subject } from '../config/subjects.js';
import { CalendarEventListSchema, type CalendarEventList } from './schema.js';
import { SYSTEM_PROMPT } from './prompt.js';
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

export async function extractEvents(
  subject: Subject,
  source: Source,
  content: string,
): Promise<CalendarEventList | null> {
  const start = Date.now();
  try {
    const result = await generateObject({
      model: getProvider()(DEFAULT_MODEL),
      schema: CalendarEventListSchema,
      temperature: 0.2,
      // 400 truncated mid-JSON on full course pages (~8+ events). 2000 fits
      // even verbose syllabi with room to spare and is still ~$0.0012 per
      // call on gpt-4o-mini.
      maxTokens: 2000,
      system: SYSTEM_PROMPT,
      prompt: [
        `Subject: ${subject.name}`,
        `Professor: ${subject.professor}`,
        `Source type: ${source.type}`,
        '',
        'Content:',
        content,
      ].join('\n'),
    });
    logger.info(
      {
        subjectId: subject.id,
        model: DEFAULT_MODEL,
        ms: Date.now() - start,
        promptTokens: result.usage?.promptTokens,
        completionTokens: result.usage?.completionTokens,
        events: result.object.events.length,
      },
      'agent: extracted',
    );
    return result.object;
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
