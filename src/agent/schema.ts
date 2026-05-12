import { z } from 'zod';

export const AttachmentSchema = z.object({
  url: z.string(),
  filename: z.string(),
});

export const EVENT_KINDS = [
  'lecture',
  'tutorial',
  'office-hours',
  'assignment',
  'midterm',
  'exam',
  'other',
] as const;

export const EventKindSchema = z.enum(EVENT_KINDS);

export const CalendarEventSchema = z.object({
  itemId: z
    .string()
    .describe("Stable natural ID: 'a3', 'midterm-1', 'lec-2025-05-15'"),
  kind: EventKindSchema.describe(
    'Classification: lecture, tutorial, office-hours, assignment, midterm, exam, or other.',
  ),
  summary: z.string().describe("e.g. 'CMPT 307: Assignment 3 due'"),
  description: z.string(),
  /** Room or location, e.g. "AQ 3149" or "CourSys" for online submissions. */
  room: z
    .string()
    .nullable()
    .describe('Room / location if mentioned in the source, else null.'),
  startDateTime: z.string().describe('RFC3339 in America/Vancouver'),
  endDateTime: z.string(),
  attachments: z
    .array(AttachmentSchema)
    .describe('Attachments referenced by this event. Emit [] if none.'),
});

export const CalendarEventListSchema = z.object({
  events: z.array(CalendarEventSchema),
});

export type EventKind = z.infer<typeof EventKindSchema>;
export type CalendarEvent = z.infer<typeof CalendarEventSchema>;
export type CalendarEventList = z.infer<typeof CalendarEventListSchema>;
export type Attachment = z.infer<typeof AttachmentSchema>;
