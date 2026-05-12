import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { spawn } from 'node:child_process';
import { basename, resolve as resolvePath } from 'node:path';
import { statSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { StateStore } from '../state/store.js';
import {
  subjects,
  colorForSubject,
  type Subject,
} from '../config/subjects.js';
import {
  countRecentAgentErrors,
  googleAuthExists,
  coursysCookieAge,
  type SyncStatus,
} from './status.js';
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

function findSubject(id: string): Subject | undefined {
  return subjects.find((s) => s.id === id);
}

function readWindow(req: FastifyRequest): { fromISO?: string; toISO?: string } {
  const q = req.query as { from?: string; to?: string };
  return { fromISO: q.from, toISO: q.to };
}

export function registerRoutes(app: FastifyInstance, ctx: RouteCtx): void {
  app.get('/api/subjects', async () => {
    const now = new Date().toISOString();
    return subjects.map((s) => {
      const events = ctx.store.listCalendarItems({ subjectId: s.id, fromISO: now });
      const upcomingDeadlines = events.filter(
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
    const upcoming = ctx.store.listCalendarItems({ subjectId: id, fromISO: nowISO });
    const nextEvent = upcoming[0] ?? null;
    return {
      ...serializeSubject(subject),
      nextEvent,
    };
  });

  app.get('/api/events', async (req) => {
    const { fromISO, toISO } = readWindow(req);
    return ctx.store.listCalendarItems({ fromISO, toISO });
  });

  app.get('/api/subjects/:id/events', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!findSubject(id)) return reply.code(404).send({ error: 'not found' });
    const { fromISO, toISO } = readWindow(req);
    return ctx.store.listCalendarItems({ subjectId: id, fromISO, toISO });
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

export { makeRunState };
export type { RunState };
