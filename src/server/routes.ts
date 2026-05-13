import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { spawn } from 'node:child_process';
import { basename, resolve as resolvePath } from 'node:path';
import { statSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import { StateStore } from '../state/store.js';
import {
  loadSubjects,
  findSubject,
  createSubject,
  updateSubject,
  deleteSubject,
  colorForSubject,
  NotFoundError,
  ConflictError,
  ValidationError,
  type Subject,
} from '../config/subjectsStore.js';
import {
  countRecentAgentErrors,
  googleAuthExists,
  coursysCookieAge,
  type SyncStatus,
} from './status.js';
import { parseSchedulePdf } from '../import/sfuPdf.js';
import { bootstrapFromSchedule } from '../import/bootstrap.js';
import { syncIcalSubscription, ICAL_URL_SETTING } from '../import/icalSync.js';
import { findDuplicateSubjects, mergeSubject } from '../import/dedup.js';
import { getAuthorizedClient } from '../auth/google.js';
import { listGoogleEvents } from '../sync/calendarRead.js';
import type { OAuth2Client } from 'google-auth-library';
import { logger } from '../logger.js';

interface RouteCtx {
  store: StateStore;
  runState: RunState;
}

interface RunState {
  current: { runId: string; startedAt: string } | null;
  lastRun: { runId: string; startedAt: string; finishedAt: string; exitCode: number } | null;
}

function makeRunState(): RunState {
  return { current: null, lastRun: null };
}

function serializeSubject(s: Subject) {
  return {
    id: s.id,
    code: s.code ?? s.name,
    name: s.name,
    professor: s.professor,
    term: s.term ?? '',
    room: s.room ?? null,
    color: colorForSubject(s),
    destinationFolder: s.destinationFolder,
    sources: s.sources,
  };
}

function readWindow(req: FastifyRequest): { fromISO?: string; toISO?: string } {
  const q = req.query as { from?: string; to?: string };
  return { fromISO: q.from, toISO: q.to };
}

export function registerRoutes(app: FastifyInstance, ctx: RouteCtx): void {
  // Lazy Google auth handle, shared across requests. Cached because building
  // an OAuth2Client + reading the token file on every /api/events call is
  // wasteful — googleapis handles access-token refresh internally.
  let cachedAuth: OAuth2Client | null = null;
  async function getAuth(): Promise<OAuth2Client | null> {
    if (cachedAuth) return cachedAuth;
    try {
      cachedAuth = await getAuthorizedClient();
      return cachedAuth;
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'google auth unavailable');
      return null;
    }
  }
  async function readEvents(opts: { fromISO?: string; toISO?: string; subjectId?: string }) {
    const auth = await getAuth();
    if (!auth) return [];
    try {
      return await listGoogleEvents(auth, ctx.store, opts);
    } catch (err) {
      logger.error({ err }, 'google calendar read failed');
      return [];
    }
  }

  app.get('/api/subjects', async () => {
    const now = new Date().toISOString();
    const subjects = loadSubjects();
    const events = await readEvents({ fromISO: now });
    return subjects.map((s) => {
      const subjectEvents = events.filter((e) => e.subjectId === s.id);
      const upcomingDeadlines = subjectEvents.filter(
        (e) => e.kind === 'assignment' || e.kind === 'midterm' || e.kind === 'exam',
      );
      const files = ctx.store.listDownloadedFilesByPathPrefix(
        s.destinationFolder,
      );
      return {
        ...serializeSubject(s),
        counts: {
          upcomingDeadlines: upcomingDeadlines.length,
          files: files.length,
          sources: s.sources.length,
        },
      };
    });
  });

  app.get('/api/subjects/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const subject = findSubject(id);
    if (!subject) return reply.code(404).send({ error: 'not found' });
    const nowISO = new Date().toISOString();
    const upcoming = await readEvents({ subjectId: id, fromISO: nowISO });
    const nextEvent = upcoming[0] ?? null;
    return {
      ...serializeSubject(subject),
      nextEvent,
    };
  });

  app.post('/api/subjects', async (req, reply) => {
    try {
      const created = createSubject(req.body);
      return reply.code(201).send(serializeSubject(created));
    } catch (err) {
      return mapMutationError(err, reply);
    }
  });

  app.put('/api/subjects/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const updated = updateSubject(id, req.body);
      return serializeSubject(updated);
    } catch (err) {
      return mapMutationError(err, reply);
    }
  });

  app.delete('/api/subjects/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      deleteSubject(id);
      return reply.code(204).send();
    } catch (err) {
      return mapMutationError(err, reply);
    }
  });

  app.get('/api/events', async (req) => {
    const { fromISO, toISO } = readWindow(req);
    return readEvents({ fromISO, toISO });
  });

  app.get('/api/subjects/:id/events', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!findSubject(id)) return reply.code(404).send({ error: 'not found' });
    const { fromISO, toISO } = readWindow(req);
    return readEvents({ subjectId: id, fromISO, toISO });
  });

  app.get('/api/subjects/:id/files', async (req, reply) => {
    const { id } = req.params as { id: string };
    const subject = findSubject(id);
    if (!subject) return reply.code(404).send({ error: 'not found' });
    const rows = ctx.store.listDownloadedFilesByPathPrefix(subject.destinationFolder);
    return rows.map((r) => {
      let bytes: number | null = null;
      try {
        if (existsSync(r.path)) bytes = statSync(r.path).size;
      } catch {
        /* ignore */
      }
      return {
        filename: basename(r.path),
        path: r.path,
        size: bytes,
        addedISO: r.downloadedAt,
      };
    });
  });

  app.get('/api/status', async (): Promise<SyncStatus & {
    running: RunState['current'];
    lastRun: RunState['lastRun'];
  }> => {
    const nowMs = Date.now();
    const weekAgo = new Date(nowMs - 7 * 24 * 60 * 60 * 1000).toISOString();
    const itemsLastWeek = ctx.store
      .listCalendarItems({})
      .filter((e) => e.lastSyncedAt >= weekAgo).length;
    const lastRun = ctx.runState.lastRun;
    const lastRunISO = lastRun?.finishedAt ?? null;
    const itemsAddedLastRun = lastRun
      ? ctx.store
          .listCalendarItems({})
          .filter(
            (e) =>
              e.lastSyncedAt >= lastRun.startedAt &&
              e.lastSyncedAt <= lastRun.finishedAt,
          ).length
      : 0;
    const cookie = coursysCookieAge();
    return {
      lastRunISO,
      nextRunISO: nextCronISO(),
      itemsAddedLastRun,
      itemsAddedLastWeek: itemsLastWeek,
      agentErrorsLastWeek: countRecentAgentErrors(),
      googleAuthOk: googleAuthExists(),
      coursysAuthOk: cookie.ok,
      coursysExpiresInDays: cookie.expiresInDays,
      running: ctx.runState.current,
      lastRun: ctx.runState.lastRun,
    };
  });

  app.get('/api/subjects/dedup', async () => {
    return { suggestions: findDuplicateSubjects(loadSubjects(), ctx.store) };
  });

  app.post('/api/subjects/dedup', async (req, reply) => {
    const body = req.body as {
      merges?: Array<{ fromId?: unknown; intoId?: unknown }>;
      deleteGoogleEvents?: unknown;
    };
    if (!Array.isArray(body?.merges) || body.merges.length === 0) {
      return reply.code(400).send({ error: 'merges array is required' });
    }
    const deleteGoogleEvents = body.deleteGoogleEvents === true;
    const auth = deleteGoogleEvents ? await getAuth() : null;
    if (deleteGoogleEvents && !auth) {
      return reply.code(503).send({ error: 'google auth not set up; cannot delete google events' });
    }
    const results = [];
    for (const m of body.merges) {
      const fromId = typeof m.fromId === 'string' ? m.fromId : '';
      const intoId = typeof m.intoId === 'string' ? m.intoId : '';
      if (!fromId || !intoId) {
        return reply.code(400).send({ error: 'each merge needs fromId + intoId' });
      }
      try {
        const r = await mergeSubject({
          fromId,
          intoId,
          store: ctx.store,
          googleAuth: auth ?? undefined,
          deleteGoogleEvents,
        });
        results.push(r);
      } catch (err) {
        logger.error({ err, fromId, intoId }, 'dedup: merge failed');
        return reply.code(500).send({
          error: err instanceof Error ? err.message : String(err),
          completed: results,
        });
      }
    }
    return { merges: results };
  });

  app.get('/api/settings/ical-url', async () => {
    return { url: ctx.store.getSetting(ICAL_URL_SETTING) };
  });

  app.put('/api/settings/ical-url', async (req, reply) => {
    const body = req.body as { url?: unknown };
    const raw = typeof body?.url === 'string' ? body.url.trim() : '';
    if (raw === '') {
      ctx.store.deleteSetting(ICAL_URL_SETTING);
      return { url: null };
    }
    try {
      const u = new URL(raw);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        return reply.code(400).send({ error: 'url must be http(s)' });
      }
    } catch {
      return reply.code(400).send({ error: 'invalid url' });
    }
    ctx.store.setSetting(ICAL_URL_SETTING, raw);
    return { url: raw };
  });

  app.post('/api/import/ical', async (_req, reply) => {
    const url = ctx.store.getSetting(ICAL_URL_SETTING);
    if (!url) {
      return reply.code(400).send({ error: 'no iCal URL configured' });
    }
    try {
      const auth = await getAuth();
      if (!auth) return reply.code(503).send({ error: 'google auth not set up' });
      const result = await syncIcalSubscription(url, {
        googleAuth: auth,
        store: ctx.store,
      });
      return result;
    } catch (err) {
      logger.error({ err }, 'import:ical failed');
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(500).send({ error: msg });
    }
  });

  app.post('/api/import/sfu', async (req, reply) => {
    if (!req.isMultipart()) {
      return reply.code(400).send({ error: 'expected multipart/form-data with a "pdf" file' });
    }
    let pdfBuf: Buffer | null = null;
    let pdfName: string | null = null;
    let baseFolder: string | null = null;
    for await (const part of req.parts()) {
      if (part.type === 'file' && part.fieldname === 'pdf') {
        pdfBuf = await part.toBuffer();
        pdfName = part.filename ?? 'schedule.pdf';
      } else if (part.type === 'field' && part.fieldname === 'baseFolder') {
        baseFolder = String(part.value ?? '').trim();
      }
    }
    if (!pdfBuf) {
      return reply.code(400).send({ error: 'missing "pdf" file in form' });
    }
    if (!baseFolder) {
      baseFolder = process.env.AUTO_SCHEDULE_BASE_FOLDER ?? 'downloads';
    }
    try {
      const schedule = await parseSchedulePdf(pdfBuf);
      const googleAuth = await getAuthorizedClient();
      const result = await bootstrapFromSchedule(schedule, {
        baseFolder,
        googleAuth,
        store: ctx.store,
        sourceLabel: `pdf:${pdfName}`,
      });
      return {
        term: schedule.term,
        courses: schedule.courses.map((c) => ({
          code: c.code,
          title: c.title,
          sections: c.sections.length,
          meetings: c.sections.reduce((n, s) => n + s.meetings.length, 0),
        })),
        result,
      };
    } catch (err) {
      logger.error({ err }, 'import:sfu failed');
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(500).send({ error: msg });
    }
  });

  app.post('/api/sync', async (_req, reply) => {
    if (ctx.runState.current) {
      return reply
        .code(409)
        .send({ error: 'already running', running: ctx.runState.current });
    }
    const runId = randomUUID();
    const startedAt = new Date().toISOString();
    ctx.runState.current = { runId, startedAt };
    logger.info({ runId }, 'manual sync triggered');

    const child = spawn(
      process.execPath,
      [resolvePath('dist/index.js'), 'run'],
      {
        cwd: process.cwd(),
        env: { ...process.env, AUTO_SCHEDULE_NO_JITTER: '1' },
        stdio: 'inherit',
      },
    );
    child.on('exit', (code) => {
      ctx.runState.lastRun = {
        runId,
        startedAt,
        finishedAt: new Date().toISOString(),
        exitCode: code ?? 1,
      };
      ctx.runState.current = null;
      logger.info({ runId, exitCode: code }, 'manual sync finished');
    });
    child.on('error', (err) => {
      logger.error({ runId, err }, 'manual sync spawn failed');
      ctx.runState.current = null;
    });

    return { started: true, runId };
  });
}

/**
 * The cron runs at 08:00 and 20:00 local time (see README). Compute the next
 * occurrence from now so the UI can show "Next sync in …".
 */
function nextCronISO(now: Date = new Date()): string {
  const slots = [8, 20];
  const candidates: Date[] = [];
  for (const h of slots) {
    const c = new Date(now);
    c.setHours(h, 0, 0, 0);
    if (c > now) candidates.push(c);
  }
  if (candidates.length === 0) {
    const c = new Date(now);
    c.setDate(c.getDate() + 1);
    c.setHours(slots[0]!, 0, 0, 0);
    candidates.push(c);
  }
  candidates.sort((a, b) => a.getTime() - b.getTime());
  return candidates[0]!.toISOString();
}

function mapMutationError(err: unknown, reply: FastifyReply) {
  if (err instanceof ZodError) {
    return reply.code(400).send({
      error: 'validation_failed',
      issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  if (err instanceof ValidationError) {
    return reply.code(400).send({ error: err.message });
  }
  if (err instanceof NotFoundError) {
    return reply.code(404).send({ error: err.message });
  }
  if (err instanceof ConflictError) {
    return reply.code(409).send({ error: err.message });
  }
  throw err;
}

export { makeRunState };
export type { RunState };
