import type { EventKind } from '../agent/schema.js';

/**
 * Classify an event kind from its title/summary text. Regex over an LLM on
 * purpose: it runs on every Google Calendar read-back and Canvas import, the
 * vocabulary is tiny and stable ("LEC", "midterm", "office hours", ...), and
 * being deterministic keeps re-imports idempotent.
 */
export function classifyKind(text: string | null | undefined): EventKind {
  if (!text) return 'other';
  const t = text.toLowerCase();

  // Order matters: "final exam review lecture" should be an exam-adjacent
  // review, but "midterm" beats "lecture" when both appear.
  if (/\bmid[\s-]?term\b|\bmidt\b/.test(t)) return 'midterm';
  if (/\bfinal(\s+exam)?\b|\bexam\b|\bquiz\b/.test(t)) return 'exam';
  if (/\boffice\s*hours?\b|\boh\b/.test(t)) return 'office-hours';
  if (/\btutorial\b|\btut\b/.test(t)) return 'tutorial';
  if (/\blab(oratory)?\b/.test(t)) return 'lab';
  if (/\bseminar\b|\bsem\b/.test(t)) return 'seminar';
  if (/\blecture\b|\blec\b/.test(t)) return 'lecture';
  if (/\bassignment\b|\bhomework\b|\bhw\s*\d\b|\bdue\b|\bproject\s+(submission|deadline)\b/.test(t)) {
    return 'assignment';
  }
  return 'other';
}
