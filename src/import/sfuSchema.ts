import { z } from 'zod';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const HH_MM = /^\d{2}:\d{2}$/;

export const SFU_SECTION_TYPES = [
  'LEC',
  'TUT',
  'LAB',
  'SEM',
  'DIS',
  'STD',
  'OLC',
] as const;

export const SfuDaySchema = z.enum([
  'Mon',
  'Tue',
  'Wed',
  'Thu',
  'Fri',
  'Sat',
  'Sun',
]);

export const SfuMeetingSchema = z.object({
  day: SfuDaySchema,
  startDate: z.string().regex(ISO_DATE),
  endDate: z.string().regex(ISO_DATE),
  recurring: z.boolean(),
  startTime: z.string().regex(HH_MM),
  endTime: z.string().regex(HH_MM),
  location: z.string().nullable(),
});

export const SfuSectionSchema = z.object({
  type: z.string().min(1),
  code: z.string().min(1),
  classNumber: z.string().min(1),
  status: z.string().optional(),
  seats: z.string().optional(),
  waitList: z.string().optional(),
  campus: z.string().optional(),
  delivery: z.string().optional(),
  instructor: z.string().optional(),
  units: z.number().optional(),
  meetings: z.array(SfuMeetingSchema),
  notes: z.string().optional(),
});

export const SfuCourseSchema = z.object({
  subject: z.string().min(1),
  number: z.string().min(1),
  code: z.string().min(1),
  title: z.string().min(1),
  session: z.string().optional(),
  termStart: z.string().regex(ISO_DATE),
  termEnd: z.string().regex(ISO_DATE),
  sections: z.array(SfuSectionSchema),
});

export const SfuTermSchema = z.object({
  label: z.string().min(1),
  startDate: z.string().regex(ISO_DATE),
  endDate: z.string().regex(ISO_DATE),
});

export const SfuScheduleSchema = z.object({
  term: SfuTermSchema,
  printedBy: z.string().optional(),
  courses: z.array(SfuCourseSchema),
});

export type SfuDay = z.infer<typeof SfuDaySchema>;
export type SfuMeeting = z.infer<typeof SfuMeetingSchema>;
export type SfuSection = z.infer<typeof SfuSectionSchema>;
export type SfuCourse = z.infer<typeof SfuCourseSchema>;
export type SfuTerm = z.infer<typeof SfuTermSchema>;
export type SfuSchedule = z.infer<typeof SfuScheduleSchema>;
