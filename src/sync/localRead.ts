import type { CalendarItemRow, StateStore } from '../state/store.js';
import { logger } from '../logger.js';

export interface ListLocalEventsOptions {
  fromISO?: string;
  toISO?: string;
  subjectId?: string;
  userId?: number;
}

/**
 * Read events from the local `calendar_items` cache — the no-Google
 * counterpart of `listGoogleEvents`. Google expands recurring events for us
 * (`singleEvents: true`); here we expand the stored RRULEs ourselves so a
 * weekly lecture still shows up on every week of the schedule.
 */
export async function listLocalEvents(
  store: StateStore,
  opts: ListLocalEventsOptions = {},
): Promise<CalendarItemRow[]> {
  const now = Date.now();
  const fromMs = opts.fromISO ? Date.parse(opts.fromISO) : now - 30 * 24 * 60 * 60 * 1000;
  const toMs = opts.toISO ? Date.parse(opts.toISO) : now + 180 * 24 * 60 * 60 * 1000;

  // No time window on the query: a recurring master's start_iso is its FIRST
  // occurrence, which typically predates the window — filtering in SQL would
  // drop the whole series. Filter after expansion instead.
  const rows = await store.listCalendarItems(
    opts.subjectId ? { subjectId: opts.subjectId } : {},
    opts.userId,
  );

  const out: CalendarItemRow[] = [];
  for (const row of rows) {
    const startMs = Date.parse(row.startISO);
    const endMs = Date.parse(row.endISO);
    if (Number.isNaN(startMs) || Number.isNaN(endMs)) continue;

    if (!row.recurrence || row.recurrence.length === 0) {
      if (endMs >= fromMs && startMs < toMs) out.push(row);
      continue;
    }

    for (const instStartMs of expandRrule(row.recurrence, startMs, fromMs, toMs)) {
      const instEndMs = instStartMs + (endMs - startMs);
      if (instEndMs < fromMs || instStartMs >= toMs) continue;
      out.push({
        ...row,
        eventId: `${row.eventId}_${new Date(instStartMs).toISOString().slice(0, 10)}`,
        startISO: new Date(instStartMs).toISOString(),
        endISO: new Date(instEndMs).toISOString(),
        recurrence: null,
      });
    }
  }
  out.sort((a, b) => Date.parse(a.startISO) - Date.parse(b.startISO));
  logger.info(
    { rows: rows.length, expanded: out.length, subjectId: opts.subjectId },
    'local calendar read',
  );
  return out;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const BYDAY_INDEX: Record<string, number> = {
  SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6,
};

/**
 * Minimal RRULE expansion covering what this app actually generates and
 * ingests: FREQ=WEEKLY (with BYDAY / INTERVAL / UNTIL / COUNT) and
 * FREQ=DAILY. Instances step in fixed 24h units, so a series that crosses a
 * DST boundary drifts by an hour on the local clock — acceptable for the
 * Google-less fallback; the Google path is exact.
 */
export function expandRrule(
  rules: string[],
  dtstartMs: number,
  fromMs: number,
  toMs: number,
): number[] {
  const rule = rules.find((r) => r.toUpperCase().includes('FREQ='));
  if (!rule) return [dtstartMs];

  const parts = new Map<string, string>();
  for (const kv of rule.replace(/^RRULE:/i, '').split(';')) {
    const [k, v] = kv.split('=');
    if (k && v) parts.set(k.toUpperCase(), v.toUpperCase());
  }

  const freq = parts.get('FREQ');
  if (freq !== 'WEEKLY' && freq !== 'DAILY') return [dtstartMs];

  const interval = Math.max(1, Number(parts.get('INTERVAL') ?? '1') || 1);
  const count = parts.has('COUNT') ? Number(parts.get('COUNT')) || Infinity : Infinity;
  const untilMs = parseUntil(parts.get('UNTIL')) ?? Infinity;
  const hardStop = Math.min(toMs, untilMs, dtstartMs + 366 * DAY_MS);

  const start = new Date(dtstartMs);
  const byday = (parts.get('BYDAY') ?? '')
    .split(',')
    .map((d) => BYDAY_INDEX[d.trim()])
    .filter((d): d is number => d !== undefined);
  const days = freq === 'WEEKLY' && byday.length > 0 ? byday : [start.getUTCDay()];

  const out: number[] = [];
  const stepMs = freq === 'DAILY' ? interval * DAY_MS : DAY_MS;
  let emitted = 0;
  for (let t = dtstartMs; t <= hardStop && emitted < count; t += stepMs) {
    if (freq === 'WEEKLY') {
      const dow = new Date(t).getUTCDay();
      if (!days.includes(dow)) continue;
      // INTERVAL=2 → only weeks at an even week-offset from DTSTART.
      const weekOffset = Math.floor((t - dtstartMs) / (7 * DAY_MS));
      if (weekOffset % interval !== 0) continue;
    }
    emitted++;
    if (t >= fromMs - 366 * DAY_MS) out.push(t);
  }
  return out;
}

function parseUntil(v: string | undefined): number | null {
  if (!v) return null;
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?$/.exec(v);
  if (!m) return null;
  return Date.UTC(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4] ?? '23'),
    Number(m[5] ?? '59'),
    Number(m[6] ?? '59'),
  );
}
