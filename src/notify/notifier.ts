import type { OAuth2Client } from 'google-auth-library';
import { upsertEvent } from '../sync/calendar.js';
import { logger } from '../logger.js';

export interface PushPayload {
  title: string;
  body: string;
  /** Optional priority hint (ntfy/Pushover both support 1..5). */
  priority?: number;
}

export async function pushNotification(payload: PushPayload): Promise<void> {
  const ntfyTopic = process.env.NTFY_TOPIC;
  const pushoverToken = process.env.PUSHOVER_TOKEN;
  const pushoverUser = process.env.PUSHOVER_USER;

  if (ntfyTopic) {
    await sendNtfy(ntfyTopic, payload);
    return;
  }
  if (pushoverToken && pushoverUser) {
    await sendPushover(pushoverToken, pushoverUser, payload);
    return;
  }
  logger.warn(
    { title: payload.title },
    'no notifier configured (set NTFY_TOPIC or PUSHOVER_TOKEN+PUSHOVER_USER)',
  );
}

async function sendNtfy(topic: string, payload: PushPayload): Promise<void> {
  const res = await fetch(`https://ntfy.sh/${topic}`, {
    method: 'POST',
    headers: {
      'Title': payload.title,
      ...(payload.priority ? { 'Priority': String(payload.priority) } : {}),
    },
    body: payload.body,
  });
  if (!res.ok) {
    throw new Error(`ntfy push failed: ${res.status} ${res.statusText}`);
  }
}

async function sendPushover(
  token: string,
  user: string,
  payload: PushPayload,
): Promise<void> {
  const params = new URLSearchParams({
    token,
    user,
    title: payload.title,
    message: payload.body,
  });
  if (payload.priority) params.set('priority', String(payload.priority));
  const res = await fetch('https://api.pushover.net/1/messages.json', {
    method: 'POST',
    body: params,
  });
  if (!res.ok) {
    throw new Error(`pushover push failed: ${res.status} ${res.statusText}`);
  }
}

/**
 * Finds the next free 30-minute slot today (between now and 23:00 local) and
 * returns RFC3339 start/end strings. If today is full we push the slot to
 * tomorrow morning so the reminder still fires the next workday.
 */
export function nextReauthSlot(now: Date = new Date()): { start: Date; end: Date } {
  // Round up to the next 15-minute boundary.
  const start = new Date(now);
  start.setSeconds(0, 0);
  const minutes = start.getMinutes();
  const remainder = minutes % 15;
  start.setMinutes(minutes + (remainder === 0 ? 15 : 15 - remainder));

  // If we've pushed past 23:00 local, jump to tomorrow at 09:00.
  if (start.getHours() >= 23) {
    start.setDate(start.getDate() + 1);
    start.setHours(9, 0, 0, 0);
  }

  const end = new Date(start.getTime() + 30 * 60 * 1000);
  return { start, end };
}

export async function notifyAuthFailure(
  service: 'coursys' | 'google',
  auth: OAuth2Client | null,
  reason: string,
): Promise<void> {
  const title = `auto-schedule: re-auth ${service}`;
  const body = `${service} session expired. ${reason}\n\nRun \`npm run setup:${service}\` to recover.`;

  try {
    await pushNotification({ title, body, priority: 4 });
  } catch (err) {
    logger.error({ err }, 'notifier push failed');
  }

  // Only the Google client can write a calendar event. If Google itself is the
  // problem we can't recover here  -  just log.
  if (!auth) {
    return;
  }
  try {
    const { start, end } = nextReauthSlot();
    await upsertEvent(auth, 'system', {
      itemId: `reauth-${service}`,
      kind: 'other',
      summary: title,
      description: body,
      room: null,
      startDateTime: start.toISOString(),
      endDateTime: end.toISOString(),
      attachments: [],
    });
  } catch (err) {
    logger.error({ err }, 'reauth calendar event write failed');
  }
}
