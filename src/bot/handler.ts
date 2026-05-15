import { generateText, type CoreMessage } from 'ai';
import { createOpenAI, type OpenAIProvider } from '@ai-sdk/openai';
import { buildBotTools } from './tools.js';
import type { StateStore } from '../state/store.js';
import { logger } from '../logger.js';

const BOT_MODEL = process.env.BOT_MODEL ?? 'openai/gpt-4o-mini';
const TZ = process.env.BOT_TIMEZONE ?? 'America/Vancouver';
const HISTORY_TURNS = 10;

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
      'X-Title': 'auto-schedule-bot',
    },
  });
  return cachedProvider;
}

function systemPrompt(): string {
  const now = new Date().toLocaleString('en-CA', {
    timeZone: TZ,
    dateStyle: 'full',
    timeStyle: 'short',
  });
  return [
    'You are the user\'s personal schedule assistant, reachable on WhatsApp.',
    `Local time right now: ${now} (${TZ}).`,
    'Use the tools to look up real events — never invent dates, rooms, or assignments.',
    'When formatting times for the user, show local time (weekday + short date + HH:mm), not raw ISO.',
    'Keep replies short and direct — this is a phone message. Plain text only, no markdown headers.',
    'If a question is ambiguous, list the most likely matches with one short clarifying question.',
    'If no events match, say so plainly instead of guessing.',
  ].join('\n');
}

export interface HandleResult {
  reply: string;
  toolCalls: number;
}

export async function handleIncomingMessage(
  store: StateStore,
  phone: string,
  text: string,
  userId?: number,
): Promise<HandleResult> {
  await store.appendChatMessage(phone, 'user', text, userId);

  const history = await store.getRecentChatMessages(phone, HISTORY_TURNS * 2, userId);
  const messages: CoreMessage[] = history.map((m) => ({
    role: m.role,
    content: m.body,
  }));

  const started = Date.now();
  const result = await generateText({
    model: getProvider()(BOT_MODEL),
    temperature: 0.3,
    maxSteps: 5,
    maxTokens: 800,
    system: systemPrompt(),
    messages,
    tools: buildBotTools(store, userId),
  });

  const reply = result.text.trim() || 'sorry, I drew a blank — try again?';
  await store.appendChatMessage(phone, 'assistant', reply, userId);

  const toolCalls = result.steps?.reduce((n, s) => n + s.toolCalls.length, 0) ?? 0;
  logger.info(
    {
      phone,
      ms: Date.now() - started,
      model: BOT_MODEL,
      promptTokens: result.usage?.promptTokens,
      completionTokens: result.usage?.completionTokens,
      steps: result.steps?.length,
      toolCalls,
      replyChars: reply.length,
    },
    'bot: replied',
  );

  return { reply, toolCalls };
}
