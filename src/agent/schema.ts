import { z } from 'zod';

export const AttachmentSchema = z.object({
  url: z.string(),
  filename: z.string(),
});

export const CalendarEventSchema = z.object({
  itemId: z
    .string()
    .describe("Stable natural ID: 'a3', 'midterm-1', 'lec-2025-05-15'"),
  summary: z.string().describe("e.g. 'CMPT 307: Assignment 3 due'"),
  description: z.string(),
  startDateTime: z.string().describe('RFC3339 in America/Vancouver'),
  endDateTime: z.string(),
  attachments: z
    .array(AttachmentSchema)
    .describe('Attachments referenced by this event. Emit [] if none.'),
});

export const CalendarEventListSchema = z.object({
  events: z.array(CalendarEventSchema),
});

export type CalendarEvent = z.infer<typeof CalendarEventSchema>;
export type CalendarEventList = z.infer<typeof CalendarEventListSchema>;
export type Attachment = z.infer<typeof AttachmentSchema>;
