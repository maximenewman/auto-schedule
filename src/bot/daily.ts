import { loadMetaConfig, sendTemplate } from './meta.js';
import type { StateStore } from '../state/store.js';
import { loadSubjects, type Subject } from '../config/subjectsStore.js';
import { logger } from '../logger.js';

const TZ = process.env.BOT_TIMEZONE ?? 'America/Vancouver';
const TEMPLATE_NAME = process.env.WA_DAILY_TEMPLATE ?? 'daily_digest';
const TEMPLATE_LANG = process.env.WA_DAILY_TEMPLATE_LANG ?? 'en_US';

function todayBoundsISO(now: Date = new Date()): { startISO: string; endISO: string; label: string } {
  // Find midnight + next midnight in the user's timezone. We do this by
  // formatting `now` as YYYY-MM-DD in TZ, then asking Intl what the UTC
  // offset is at that local midnight.
  const dateParts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (t: string) => dateParts.find((p) => p.type === t)?.value ?? '';
  const ymd = `${get('year')}-${get('month')}-${get('day')}`;

  // Use the offset of the local midnight, derived via a probe Date.
  const offsetMinutes = tzOffsetMinutes(new Date(`${ymd}T12:00:00Z`));
  const sign = offsetMinutes <= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  const offset = `${sign}${hh}:${mm}`;

  const startISO = new Date(`${ymd}T00:00:00${offset}`).toISOString();
  const tomorrow = new Date(`${ymd}T00:00:00${offset}`);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const endISO = tomorrow.toISOString();

  const label = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(now);
  return { startISO, endISO, label };
}

function tzOffsetMinutes(at: Date): number {
  // Offset (in minutes west of UTC) for `at` interpreted in TZ. Returns the
  // value that, when added to UTC, yields local — same sign convention as
  // Date.prototype.getTimezoneOffset (positive west).
  const local = new Date(
    at.toLocaleString('en-US', { timeZone: TZ }),
  );
  const utc = new Date(at.toLocaleString('en-US', { timeZone: 'UTC' }));
  return Math.round((utc.getTime() - local.getTime()) / 60000);
}

function fmtTime(iso: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));
}

function subjectShort(subjects: Subject[], subjectId: string): string {
  const s = subjects.find((x) => x.id === subjectId);
  return s?.code ?? s?.name ?? subjectId;
}

interface DigestRow {
  subjectId: string;
  kind: string;
  summary: string;
  startISO: string;
}

function formatDigestBody(items: DigestRow[], subjects: Subject[]): string {
  if (items.length === 0) return 'nothing scheduled.';
  return items
    .map((e) => {
      const code = subjectShort(subjects, e.subjectId);
      return `${fmtTime(e.startISO)} ${code} — ${e.summary}`;
    })
    .join('; ');
}

export interface DailyDigestResult {
  sent: boolean;
  reason?: string;
  count: number;
}

/**
 * Query today's events (in the user's timezone) and push a templated message
 * via WhatsApp. Skips sending when the day is empty so we don't burn template
 * messages on no-ops.
 *
 * Requires a pre-approved template named WA_DAILY_TEMPLATE (default
 * "daily_digest") with two body placeholders: {{1}} = date label, {{2}} =
 * event list. Free-form text is rejected by Meta outside the 24h customer
 * service window, which is why this path uses templates.
 */
export async function sendDailyDigest(
  store: StateStore,
): Promise<DailyDigestResult> {
  const cfg = loadMetaConfig();
  const subjects = loadSubjects();
  const { startISO, endISO, label } = todayBoundsISO();
  const rows = await store.listCalendarItems({ fromISO: startISO, toISO: endISO });
  const items = rows.map((r) => ({
    subjectId: r.subjectId,
    kind: r.kind,
    summary: r.summary,
    startISO: r.startISO,
  }));

  if (items.length === 0) {
    logger.info({ label }, 'daily digest: nothing scheduled, skipping');
    return { sent: false, reason: 'empty', count: 0 };
  }

  const body = formatDigestBody(items, subjects);
  await sendTemplate(
    cfg.recipient,
    TEMPLATE_NAME,
    [label, body],
    TEMPLATE_LANG,
    cfg,
  );
  // Record outbound so the bot can reference it if the user replies.
  await store.appendChatMessage(
    cfg.recipient,
    'assistant',
    `[daily digest ${label}] ${body}`,
  );
  return { sent: true, count: items.length };
}
