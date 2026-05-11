import { generateObject, NoObjectGeneratedError } from 'ai';
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
  try {
    const { object } = await generateObject({
      model: getProvider()(DEFAULT_MODEL),
      schema: CalendarEventListSchema,
      temperature: 0.2,
      maxTokens: 400,
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
    return object;
  } catch (err) {
    const raw = NoObjectGeneratedError.isInstance(err) ? err.text : undefined;
    logRawFailure(subject, source, content, err, raw);
    return null;
  }
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
  const message = err instanceof Error ? err.message : String(err);
  writeFileSync(
    file,
    JSON.stringify(
      {
        when: new Date().toISOString(),
        subjectId: subject.id,
        source,
        error: message,
        rawModelOutput: raw,
        inputContent: content,
      },
      null,
      2,
    ),
  );
  logger.error({ file, subjectId: subject.id }, 'agent extraction failed; raw output logged');
}
