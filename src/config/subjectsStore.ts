import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { logger } from '../logger.js';
import {
  SUBJECT_PALETTE,
  colorForSubject,
  subjects as SEED_SUBJECTS,
  type Source,
  type Subject,
} from './subjects.js';

const STORE_PATH = resolve('data/subjects.json');

const SourceSchema = z.union([
  z.object({ type: z.literal('email'), label: z.string().min(1) }),
  z.object({ type: z.literal('site'), url: z.string().url() }),
]);

export const SubjectSchema = z.object({
  id: z.string().min(1).regex(/^[a-z0-9_-]+$/i, 'id may only contain letters, digits, _ or -'),
  code: z.string().optional(),
  name: z.string().min(1),
  professor: z.string().default(''),
  room: z.string().optional(),
  term: z.string().optional(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'color must be a #rrggbb hex string')
    .optional(),
  destinationFolder: z.string().min(1),
  sources: z.array(SourceSchema).default([]),
});

const SubjectsFileSchema = z.object({
  subjects: z.array(SubjectSchema),
});

let cache: Subject[] | null = null;

/** Read subjects from disk, seeding the file from the compiled-in defaults
 *  on first call so existing setups keep working without manual migration. */
export function loadSubjects(): Subject[] {
  if (cache) return cache;
  if (!existsSync(STORE_PATH)) {
    // Seed on first boot from the compiled-in defaults so existing installs
    // don't need a manual migration step.
    writeSubjectsFile(SEED_SUBJECTS);
    cache = SEED_SUBJECTS;
    return cache;
  }
  const raw = readFileSync(STORE_PATH, 'utf8');
  const parsed = SubjectsFileSchema.parse(JSON.parse(raw));
  cache = parsed.subjects;
  return cache;
}

export function saveSubjects(next: Subject[]): void {
  writeSubjectsFile(next);
  cache = next;
}

export function findSubject(id: string): Subject | undefined {
  return loadSubjects().find((s) => s.id === id);
}

export function createSubject(input: unknown): Subject {
  const subject = SubjectSchema.parse(input);
  const current = loadSubjects();
  if (current.some((s) => s.id === subject.id)) {
    throw new ConflictError(`subject "${subject.id}" already exists`);
  }
  saveSubjects([...current, subject]);
  logger.info({ id: subject.id }, 'subject created');
  return subject;
}

export function updateSubject(id: string, input: unknown): Subject {
  const incoming = SubjectSchema.parse(input);
  if (incoming.id !== id) {
    throw new ValidationError(`body id "${incoming.id}" does not match path id "${id}"`);
  }
  const current = loadSubjects();
  const idx = current.findIndex((s) => s.id === id);
  if (idx === -1) throw new NotFoundError(`subject "${id}" not found`);
  const next = [...current];
  next[idx] = incoming;
  saveSubjects(next);
  logger.info({ id }, 'subject updated');
  return incoming;
}

export function deleteSubject(id: string): void {
  const current = loadSubjects();
  const idx = current.findIndex((s) => s.id === id);
  if (idx === -1) throw new NotFoundError(`subject "${id}" not found`);
  const next = current.filter((_, i) => i !== idx);
  saveSubjects(next);
  logger.info({ id }, 'subject deleted');
}

function writeSubjectsFile(subjects: Subject[]): void {
  mkdirSync(dirname(STORE_PATH), { recursive: true });
  writeFileSync(
    STORE_PATH,
    JSON.stringify({ subjects }, null, 2) + '\n',
    'utf8',
  );
}

export class NotFoundError extends Error {
  constructor(message: string) { super(message); this.name = 'NotFoundError'; }
}
export class ConflictError extends Error {
  constructor(message: string) { super(message); this.name = 'ConflictError'; }
}
export class ValidationError extends Error {
  constructor(message: string) { super(message); this.name = 'ValidationError'; }
}

export { SUBJECT_PALETTE, colorForSubject };
export type { Subject, Source };
