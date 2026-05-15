import { z } from 'zod';
import { logger } from '../logger.js';
import {
  SUBJECT_PALETTE,
  colorForSubject,
  type Source,
  type Subject,
} from './subjects.js';
import { DEFAULT_USER_ID, type Store } from '../state/store.js';

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

export async function loadSubjects(
  store: Store,
  userId: number = DEFAULT_USER_ID,
): Promise<Subject[]> {
  return store.listSubjects(userId);
}

export async function findSubject(
  store: Store,
  id: string,
  userId: number = DEFAULT_USER_ID,
): Promise<Subject | undefined> {
  return store.getSubject(id, userId);
}

export async function createSubject(
  store: Store,
  input: unknown,
  userId: number = DEFAULT_USER_ID,
): Promise<Subject> {
  const subject = SubjectSchema.parse(input);
  const result = await store.insertSubject(subject, userId);
  if (!result.ok) {
    throw new ConflictError(`subject "${subject.id}" already exists`);
  }
  logger.info({ id: subject.id, userId }, 'subject created');
  return subject;
}

export async function updateSubject(
  store: Store,
  id: string,
  input: unknown,
  userId: number = DEFAULT_USER_ID,
): Promise<Subject> {
  const incoming = SubjectSchema.parse(input);
  if (incoming.id !== id) {
    throw new ValidationError(`body id "${incoming.id}" does not match path id "${id}"`);
  }
  const ok = await store.replaceSubject(incoming, userId);
  if (!ok) throw new NotFoundError(`subject "${id}" not found`);
  logger.info({ id, userId }, 'subject updated');
  return incoming;
}

export async function deleteSubject(
  store: Store,
  id: string,
  userId: number = DEFAULT_USER_ID,
): Promise<void> {
  const ok = await store.removeSubject(id, userId);
  if (!ok) throw new NotFoundError(`subject "${id}" not found`);
  logger.info({ id, userId }, 'subject deleted');
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
