import { tool } from 'ai';
import { z } from 'zod';
import type { StateStore } from '../state/store.js';
import { loadSubjects, type Subject } from '../config/subjectsStore.js';

interface ToolEvent {
  subject: string;
  kind: string;
  summary: string;
  startISO: string;
  endISO: string;
  room: string | null;
  description: string;
}

function subjectLabel(subjects: Subject[], subjectId: string): string {
  const s = subjects.find((x) => x.id === subjectId);
  if (!s) return subjectId;
  return s.code ? `${s.code} (${s.name})` : s.name;
}

function shape(
  row: {
    subjectId: string;
    kind: string;
    summary: string;
    startISO: string;
    endISO: string;
    room: string | null;
    description: string;
  },
  subjects: Subject[],
): ToolEvent {
  return {
    subject: subjectLabel(subjects, row.subjectId),
    kind: row.kind,
    summary: row.summary,
    startISO: row.startISO,
    endISO: row.endISO,
    room: row.room,
    description: row.description.length > 400
      ? row.description.slice(0, 400) + '…'
      : row.description,
  };
}

function resolveSubjectId(input: string, subjects: Subject[]): string | null {
  const q = input.trim().toLowerCase();
  if (!q) return null;
  // Exact id, then code, then name substring.
  const byId = subjects.find((s) => s.id.toLowerCase() === q);
  if (byId) return byId.id;
  const byCode = subjects.find(
    (s) => s.code && s.code.toLowerCase() === q,
  );
  if (byCode) return byCode.id;
  const byCodeLoose = subjects.find(
    (s) => s.code && s.code.toLowerCase().replace(/\s+/g, '') === q.replace(/\s+/g, ''),
  );
  if (byCodeLoose) return byCodeLoose.id;
  const byName = subjects.find((s) => s.name.toLowerCase().includes(q));
  return byName?.id ?? null;
}

export function buildBotTools(store: StateStore) {
  const subjects = loadSubjects();

  return {
    list_upcoming: tool({
      description:
        'List the user\'s upcoming calendar items in the next N days. Returns events in chronological order. Use this for questions like "what\'s on tomorrow", "what do I have this week", or daily digests.',
      parameters: z.object({
        daysAhead: z
          .number()
          .int()
          .min(1)
          .max(60)
          .default(7)
          .describe('How many days ahead to look. Default 7.'),
        kinds: z
          .array(
            z.enum([
              'lecture',
              'tutorial',
              'office-hours',
              'assignment',
              'midterm',
              'exam',
              'other',
            ]),
          )
          .optional()
          .describe('Optional kind filter — omit for everything.'),
      }),
      execute: async ({ daysAhead, kinds }) => {
        const now = new Date();
        const end = new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000);
        const rows = await store.listCalendarItems({
          fromISO: now.toISOString(),
          toISO: end.toISOString(),
        });
        const filtered = kinds && kinds.length > 0
          ? rows.filter((r) => kinds.includes(r.kind as typeof kinds[number]))
          : rows;
        return {
          fromISO: now.toISOString(),
          toISO: end.toISOString(),
          count: filtered.length,
          events: filtered.slice(0, 30).map((r) => shape(r, subjects)),
        };
      },
    }),

    search_events: tool({
      description:
        'Full-text-ish search across event summary and description. Use when the user asks about a specific assignment, topic, or keyword (e.g. "when is assignment 3", "midterm date").',
      parameters: z.object({
        query: z.string().min(1).describe('Keyword(s) to search for.'),
        includePast: z
          .boolean()
          .default(false)
          .describe('Include events that already happened. Default false.'),
      }),
      execute: async ({ query, includePast }) => {
        const q = query.toLowerCase();
        const fromISO = includePast ? undefined : new Date().toISOString();
        const rows = await store.listCalendarItems({ fromISO });
        const hits = rows.filter(
          (r) =>
            r.summary.toLowerCase().includes(q) ||
            r.description.toLowerCase().includes(q),
        );
        return {
          query,
          count: hits.length,
          events: hits.slice(0, 20).map((r) => shape(r, subjects)),
        };
      },
    }),

    events_for_subject: tool({
      description:
        'List events for a specific subject. Accepts course id ("cmpt307"), code ("CMPT 307"), or name substring ("data structures"). Use when the user asks "what\'s next in stat 271" etc.',
      parameters: z.object({
        subject: z
          .string()
          .describe('Course id, code, or partial name.'),
        daysAhead: z
          .number()
          .int()
          .min(1)
          .max(180)
          .default(30)
          .describe('How many days ahead to look. Default 30.'),
      }),
      execute: async ({ subject, daysAhead }) => {
        const subjectId = resolveSubjectId(subject, subjects);
        if (!subjectId) {
          return {
            error: `no subject matched "${subject}"`,
            knownSubjects: subjects.map((s) => ({
              id: s.id,
              code: s.code ?? null,
              name: s.name,
            })),
          };
        }
        const now = new Date();
        const end = new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000);
        const rows = await store.listCalendarItems({
          subjectId,
          fromISO: now.toISOString(),
          toISO: end.toISOString(),
        });
        return {
          subjectId,
          subject: subjectLabel(subjects, subjectId),
          count: rows.length,
          events: rows.slice(0, 30).map((r) => shape(r, subjects)),
        };
      },
    }),

    list_subjects: tool({
      description:
        'List all subjects the user is enrolled in. Use when the user asks what courses they have, or when you need to disambiguate a subject reference.',
      parameters: z.object({}),
      execute: async () => ({
        subjects: subjects.map((s) => ({
          id: s.id,
          code: s.code ?? null,
          name: s.name,
          professor: s.professor,
          term: s.term ?? null,
        })),
      }),
    }),
  };
}

export type BotTools = ReturnType<typeof buildBotTools>;
