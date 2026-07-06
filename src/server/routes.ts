import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { spawn } from 'node:child_process';
import { resolve as resolvePath } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import { DEFAULT_USER_ID, type StateStore } from '../state/store.js';
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
  canvasTokenStatus,
  type SyncStatus,
} from './status.js';
import { parseSchedulePdf } from '../import/sfuPdf.js';
import { bootstrapFromSchedule } from '../import/bootstrap.js';
import { syncIcalSubscription, runFullIcalSync, ICAL_URL_SETTING, type IcalProgress } from '../import/icalSync.js';
import { syncAtomSubscription, ATOM_URL_SETTING, type AtomProgress } from '../import/atomSync.js';
import { mergeSubject, mergeEvent } from '../import/dedup.js';
import { planDedup } from '../import/dedupAgent.js';
import { deleteSubjectAndCalendar } from '../import/reconcile.js';
import { getAuthorizedClient } from '../auth/google.js';
import { listGoogleEvents } from '../sync/calendarRead.js';
import { listLocalEvents } from '../sync/localRead.js';
import type { OAuth2Client } from 'google-auth-library';
import { getAuth as getClerkAuth, clerkClient } from '@clerk/fastify';
import { logger } from '../logger.js';
import {
  handleVerifyHandshake,
  loadMetaConfig,
  parseInboundText,
  sendText,
  verifyWebhookSignature,
  MetaConfigError,
} from '../bot/meta.js';
import { handleIncomingMessage } from '../bot/handler.js';
import {
  buildGoogleAuthUrl,
  exchangeCodeForTokens,
} from '../auth/google.js';
import { CanvasClient, CanvasAuthError } from '../sources/canvasClient.js';
import { syncCanvas, type CanvasProgress } from '../import/canvasSync.js';
import { syncCourseFiles } from '../import/canvasFiles.js';
import { extractPendingAnnouncements } from '../import/announcementExtract.js';
import { presignGetUrl } from '../files/storage.js';
import { randomBytes } from 'node:crypto';

declare module 'fastify' {
  interface FastifyRequest {
    userId?: number;
  }
}

const OAUTH_STATE_SETTING = 'google.oauth_state';

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
    section: s.section ?? null,
    color: colorForSubject(s),
  };
}

function readWindow(req: FastifyRequest): { fromISO?: string; toISO?: string } {
  const q = req.query as { from?: string; to?: string };
  return { fromISO: q.from, toISO: q.to };
}

function isProtectedPath(url: string): boolean {
  // Strip query string for the prefix match. We protect /api/* (the dashboard
  // backend) but leave /auth/* (the login flow), /bot/* (Meta webhook, which
  // verifies via HMAC instead), and the static SPA + index.html open.
  const path = url.split('?')[0]!;
  return path.startsWith('/api/');
}

export function registerRoutes(app: FastifyInstance, ctx: RouteCtx): void {
  // Clerk resolution: map the request's Clerk user onto a local users row and
  // attach req.userId. Cached per process — findOrCreateUserByClerkId only
  // runs on the first request of a given Clerk user.
  const localIdByClerkId = new Map<string, number>();
  app.addHook('preHandler', async (req, reply) => {
    const auth = getClerkAuth(req);
    if (auth.userId) {
      let localId = localIdByClerkId.get(auth.userId);
      if (localId === undefined) {
        try {
          const cu = await clerkClient.users.getUser(auth.userId);
          const email =
            cu.primaryEmailAddress?.emailAddress ??
            cu.emailAddresses[0]?.emailAddress ??
            null;
          if (email) {
            const displayName =
              [cu.firstName, cu.lastName].filter(Boolean).join(' ') || null;
            const user = await ctx.store.findOrCreateUserByClerkId({
              clerkUserId: auth.userId,
              email,
              displayName,
            });
            localId = user.id;
            localIdByClerkId.set(auth.userId, localId);
            logger.info(
              { userId: localId, clerkUserId: auth.userId, email },
              'auth: clerk user resolved',
            );
          } else {
            logger.error({ clerkUserId: auth.userId }, 'auth: clerk user has no email');
          }
        } catch (err) {
          logger.error({ err, clerkUserId: auth.userId }, 'auth: clerk resolution failed');
        }
      }
      if (localId !== undefined) req.userId = localId;
    }
    if (req.userId === undefined && isProtectedPath(req.url)) {
      return reply.code(401).send({ error: 'not authenticated' });
    }
  });

  // ---- auth flow -------------------------------------------------------

  // Public: the SPA fetches the publishable key here before loading clerk-js
  // (no bundler, so the key can't be inlined at build time).
  app.get('/auth/config', async () => ({
    clerkPublishableKey: process.env.CLERK_PUBLISHABLE_KEY ?? null,
  }));

  app.get('/auth/me', async (req, reply) => {
    if (req.userId === undefined) {
      return reply.code(200).send({ authenticated: false });
    }
    const user = await ctx.store.getUserById(req.userId);
    if (!user) return reply.code(200).send({ authenticated: false });
    return {
      authenticated: true,
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
      },
    };
  });

  // ---- optional Google Calendar connect ---------------------------------
  //
  // Requested via authed fetch (not top-level navigation) so the Clerk Bearer
  // token identifies the user. The random state token is persisted in
  // user_settings (state -> userId) rather than a cookie: the redirect back
  // from Google may land on a different host alias (localhost vs 127.0.0.1),
  // where a cookie set on the app origin would silently not be sent.

  app.get('/api/google/start-url', async (req) => {
    const userId = req.userId!;
    const state = randomBytes(16).toString('base64url');
    await ctx.store.setSetting(OAUTH_STATE_SETTING, state, userId);
    return { url: buildGoogleAuthUrl(state) };
  });

  app.get('/auth/google/callback', async (req, reply) => {
    const q = req.query as { code?: string; state?: string; error?: string };
    if (q.error) {
      return reply.code(400).send({ error: `google: ${q.error}` });
    }
    if (!q.code || !q.state) {
      return reply.code(400).send({ error: 'missing code or state' });
    }
    const userId = await ctx.store.consumeSettingByValue(OAUTH_STATE_SETTING, q.state);
    if (userId === null) {
      return reply.code(400).send({
        error: 'oauth state unknown or already used — restart the connect flow from the app',
      });
    }

    let credentials;
    try {
      credentials = await exchangeCodeForTokens(q.code);
    } catch (err) {
      logger.error({ err }, 'auth: token exchange failed');
      return reply.code(500).send({ error: 'token exchange failed' });
    }

    await ctx.store.saveGoogleTokens(userId, {
      refreshToken: credentials.refresh_token ?? null,
      accessToken: credentials.access_token ?? null,
      accessTokenExpires: credentials.expiry_date
        ? new Date(credentials.expiry_date)
        : null,
      scope: credentials.scope ?? null,
    });
    authCache.delete(userId);
    logger.info({ userId }, 'auth: google calendar connected');
    return reply.redirect('/');
  });

  app.post('/api/google/disconnect', async (req) => {
    const userId = req.userId!;
    await ctx.store.clearGoogleTokens(userId);
    authCache.delete(userId);
    logger.info({ userId }, 'auth: google calendar disconnected');
    return { connected: false };
  });

  // ---- Canvas token ------------------------------------------------------

  app.get('/api/canvas/token', async (req) => {
    const userId = req.userId!;
    const row = await ctx.store.getCanvasToken(userId);
    if (!row) return { configured: false, baseUrl: null, updatedAt: null };
    // Never echo the token itself.
    return {
      configured: true,
      baseUrl: row.baseUrl,
      updatedAt: row.updatedAt ? row.updatedAt.toISOString() : null,
    };
  });

  app.post('/api/canvas/token', async (req, reply) => {
    const userId = req.userId!;
    const body = req.body as { token?: unknown; baseUrl?: unknown };
    const token = typeof body.token === 'string' ? body.token.trim() : '';
    if (!token) {
      return reply.code(400).send({ error: 'token is required' });
    }
    let baseUrl: string | undefined;
    if (typeof body.baseUrl === 'string' && body.baseUrl.trim() !== '') {
      try {
        const u = new URL(body.baseUrl.trim());
        if (u.protocol !== 'https:') {
          return reply.code(400).send({ error: 'baseUrl must be https' });
        }
        baseUrl = u.origin;
      } catch {
        return reply.code(400).send({ error: 'invalid baseUrl' });
      }
    }
    // Validate before saving so a bad paste fails loudly here, not at 2am.
    try {
      const who = await new CanvasClient(token, baseUrl).whoAmI();
      await ctx.store.saveCanvasToken(userId, token, baseUrl);
      logger.info({ userId, canvasUser: who.name }, 'canvas: token saved');
      return { configured: true, canvasUser: who.name };
    } catch (err) {
      if (err instanceof CanvasAuthError) {
        return reply.code(400).send({ error: 'Canvas rejected the token — double-check it' });
      }
      logger.error({ err }, 'canvas: token validation failed');
      return reply.code(502).send({ error: 'could not reach Canvas to validate the token' });
    }
  });

  app.delete('/api/canvas/token', async (req) => {
    const userId = req.userId!;
    await ctx.store.clearCanvasToken(userId);
    return { configured: false };
  });

  app.post('/api/import/canvas', async (req, reply) => {
    const userId = req.userId!;
    const token = await ctx.store.getCanvasToken(userId);
    if (!token) {
      return reply.code(400).send({ error: 'no Canvas token configured' });
    }
    const auth = await getAuth(userId);
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'content-type': 'application/x-ndjson',
      'cache-control': 'no-cache',
      'x-accel-buffering': 'no',
    });
    const emit = (evt: CanvasProgress) => {
      raw.write(JSON.stringify(evt) + '\n');
    };
    try {
      await syncCanvas(
        {
          store: ctx.store,
          userId,
          googleAuth: auth,
          fileSink: (o) => syncCourseFiles({ ...o, store: ctx.store }),
        },
        emit,
      );
      // Follow straight into the LLM pass so freshly-imported announcements
      // become events in the same click.
      const extract = await extractPendingAnnouncements({
        store: ctx.store, userId, googleAuth: auth,
      });
      raw.write(JSON.stringify({ stage: 'extract', status: 'done', ...extract }) + '\n');
    } catch (err) {
      logger.error({ err }, 'import:canvas failed');
      const message = err instanceof Error ? err.message : String(err);
      try {
        raw.write(JSON.stringify({ stage: 'error', message } satisfies CanvasProgress) + '\n');
      } catch {
        /* response may already be closed */
      }
    } finally {
      raw.end();
    }
  });

  app.post('/api/announcements/extract', async (req) => {
    const userId = req.userId!;
    const auth = await getAuth(userId);
    return extractPendingAnnouncements({ store: ctx.store, userId, googleAuth: auth });
  });

  // ---- files (Canvas -> object storage) ----------------------------------

  app.get('/api/subjects/:id/files', async (req, reply) => {
    const userId = req.userId!;
    const { id } = req.params as { id: string };
    if (!(await findSubject(ctx.store, id, userId))) {
      return reply.code(404).send({ error: 'not found' });
    }
    const rows = await ctx.store.listFiles({ subjectId: id }, userId);
    return rows.map((f) => ({
      id: f.canvasFileId,
      filename: f.filename,
      size: f.size,
      contentType: f.contentType,
      folderPath: f.folderPath,
      addedISO: f.canvasUpdatedAt
        ? f.canvasUpdatedAt.toISOString()
        : typeof f.createdAt === 'string'
          ? f.createdAt
          : f.createdAt.toISOString(),
    }));
  });

  // One-subject file sync — the "Sync files" button on the subject page.
  app.post('/api/subjects/:id/files/sync', async (req, reply) => {
    const userId = req.userId!;
    const { id } = req.params as { id: string };
    if (!(await findSubject(ctx.store, id, userId))) {
      return reply.code(404).send({ error: 'not found' });
    }
    const courseId = await ctx.store.getCanvasCourseIdForSubject(id, userId);
    if (courseId === null) {
      return reply.code(400).send({ error: 'subject is not linked to a Canvas course' });
    }
    const token = await ctx.store.getCanvasToken(userId);
    if (!token) {
      return reply.code(400).send({ error: 'no Canvas token configured' });
    }
    const client = new CanvasClient(token.token, token.baseUrl);
    try {
      const result = await syncCourseFiles({
        client, courseId, subjectId: id, store: ctx.store, userId,
      });
      return result;
    } catch (err) {
      if (err instanceof CanvasAuthError) {
        return reply.code(401).send({ error: 'Canvas rejected the token — paste a new one' });
      }
      logger.error({ err, subjectId: id }, 'files: subject sync failed');
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/files/:id/url', async (req, reply) => {
    const userId = req.userId!;
    const { id } = req.params as { id: string };
    const q = req.query as { disposition?: string };
    const canvasFileId = Number(id);
    if (!Number.isInteger(canvasFileId)) {
      return reply.code(400).send({ error: 'bad file id' });
    }
    // Ownership check: the record lookup is scoped to the requesting user.
    const row = await ctx.store.getFileRecord(canvasFileId, userId);
    if (!row) return reply.code(404).send({ error: 'not found' });
    const disposition = q.disposition === 'attachment' ? 'attachment' : 'inline';
    try {
      const url = await presignGetUrl(row.objectKey, 300, {
        disposition,
        filename: row.filename,
      });
      return { url, filename: row.filename, contentType: row.contentType };
    } catch (err) {
      logger.error({ err }, 'files: presign failed');
      return reply.code(503).send({ error: 'object storage not configured' });
    }
  });

  // Per-user OAuth2Client cache. googleapis handles access-token refresh
  // internally, so we hold one client per user across requests instead of
  // re-reading tokens from the DB on every /api/events call.
  const authCache = new Map<number, OAuth2Client>();
  async function getAuth(userId: number): Promise<OAuth2Client | null> {
    const cached = authCache.get(userId);
    if (cached) return cached;
    try {
      const client = await getAuthorizedClient(ctx.store, userId);
      authCache.set(userId, client);
      return client;
    } catch (err) {
      logger.warn({ err: (err as Error).message, userId }, 'google auth unavailable');
      return null;
    }
  }
  async function readEvents(
    userId: number,
    opts: { fromISO?: string; toISO?: string; subjectId?: string },
  ) {
    const auth = await getAuth(userId);
    if (auth) {
      try {
        return await listGoogleEvents(auth, ctx.store, { ...opts, userId });
      } catch (err) {
        logger.error({ err, userId }, 'google calendar read failed — falling back to local');
      }
    }
    // No Google connected (or the read failed): serve the schedule from the
    // local calendar_items cache, expanding recurrences ourselves.
    try {
      return await listLocalEvents(ctx.store, { ...opts, userId });
    } catch (err) {
      logger.error({ err, userId }, 'local calendar read failed');
      return [];
    }
  }

  app.get('/api/subjects', async (req) => {
    const userId = req.userId!;
    const now = new Date().toISOString();
    const subjects = await loadSubjects(ctx.store, userId);
    const events = await readEvents(userId, { fromISO: now });
    const allFiles = await ctx.store.listFiles({}, userId);
    return subjects.map((s) => {
      const subjectEvents = events.filter((e) => e.subjectId === s.id);
      const upcomingDeadlines = subjectEvents.filter(
        (e) => e.kind === 'assignment' || e.kind === 'midterm' || e.kind === 'exam',
      );
      return {
        ...serializeSubject(s),
        counts: {
          upcomingDeadlines: upcomingDeadlines.length,
          files: allFiles.filter((f) => f.subjectId === s.id).length,
        },
      };
    });
  });

  app.get('/api/subjects/:id', async (req, reply) => {
    const userId = req.userId!;
    const { id } = req.params as { id: string };
    const subject = await findSubject(ctx.store, id, userId);
    if (!subject) return reply.code(404).send({ error: 'not found' });
    const nowISO = new Date().toISOString();
    const upcoming = await readEvents(userId, { subjectId: id, fromISO: nowISO });
    const nextEvent = upcoming[0] ?? null;
    return {
      ...serializeSubject(subject),
      nextEvent,
    };
  });

  app.post('/api/subjects', async (req, reply) => {
    const userId = req.userId!;
    try {
      const created = await createSubject(ctx.store, req.body, userId);
      return reply.code(201).send(serializeSubject(created));
    } catch (err) {
      return mapMutationError(err, reply);
    }
  });

  app.put('/api/subjects/:id', async (req, reply) => {
    const userId = req.userId!;
    const { id } = req.params as { id: string };
    try {
      const updated = await updateSubject(ctx.store, id, req.body, userId);
      return serializeSubject(updated);
    } catch (err) {
      return mapMutationError(err, reply);
    }
  });

  app.delete('/api/subjects/:id', async (req, reply) => {
    const userId = req.userId!;
    const { id } = req.params as { id: string };
    try {
      const existing = await findSubject(ctx.store, id, userId);
      if (!existing) {
        return reply.code(404).send({ error: `subject "${id}" not found` });
      }
      // Cascade through Google Calendar first so the deletion is visible
      // there. If Google auth is missing we still purge the local rows so
      // the dashboard reflects the deletion immediately.
      const auth = await getAuth(userId);
      const result = await deleteSubjectAndCalendar(id, ctx.store, auth, userId);
      return reply.code(200).send(result);
    } catch (err) {
      return mapMutationError(err, reply);
    }
  });

  app.get('/api/events', async (req) => {
    const userId = req.userId!;
    const { fromISO, toISO } = readWindow(req);
    return readEvents(userId, { fromISO, toISO });
  });

  app.get('/api/subjects/:id/events', async (req, reply) => {
    const userId = req.userId!;
    const { id } = req.params as { id: string };
    if (!(await findSubject(ctx.store, id, userId))) {
      return reply.code(404).send({ error: 'not found' });
    }
    const { fromISO, toISO } = readWindow(req);
    return readEvents(userId, { subjectId: id, fromISO, toISO });
  });

  app.get('/api/status', async (req): Promise<SyncStatus & {
    running: RunState['current'];
    lastRun: RunState['lastRun'];
  }> => {
    const userId = req.userId!;
    const nowMs = Date.now();
    const weekAgo = new Date(nowMs - 7 * 24 * 60 * 60 * 1000).toISOString();
    const lastRun = ctx.runState.lastRun;

    // Each sub-query is isolated so a single failing piece (missing
    // migration, transient DB blip, unconfigured google tokens, etc.)
    // can't 500 the whole status endpoint. The real error still hits the
    // logs so we can see what to fix.
    const safe = async <T>(name: string, fn: () => Promise<T>, fallback: T): Promise<T> => {
      try { return await fn(); } catch (err) {
        logger.error({ err, userId, sub: name }, 'status: sub-query failed');
        return fallback;
      }
    };

    const allItems = await safe('listCalendarItems', () =>
      ctx.store.listCalendarItems({}, userId), []);
    const itemsLastWeek = allItems.filter((e) => e.lastSyncedAt >= weekAgo).length;
    const itemsAddedLastRun = lastRun
      ? allItems.filter(
          (e) =>
            e.lastSyncedAt >= lastRun.startedAt &&
            e.lastSyncedAt <= lastRun.finishedAt,
        ).length
      : 0;
    const canvas = await safe('canvasTokenStatus', () =>
      canvasTokenStatus(ctx.store, userId),
      { configured: false, updatedAt: null });
    const googleOk = await safe('googleAuthExists', () =>
      googleAuthExists(ctx.store, userId), false);

    return {
      lastRunISO: lastRun?.finishedAt ?? null,
      nextRunISO: nextCronISO(),
      itemsAddedLastRun,
      itemsAddedLastWeek: itemsLastWeek,
      agentErrorsLastWeek: countRecentAgentErrors(),
      googleAuthOk: googleOk,
      canvasConfigured: canvas.configured,
      canvasTokenUpdatedAt: canvas.updatedAt,
      running: ctx.runState.current,
      lastRun: ctx.runState.lastRun,
    };
  });

  app.get('/api/subjects/dedup', async (req, reply) => {
    const userId = req.userId!;
    // Ask the LLM for a dedup plan. Returned as-is so the UI can preview
    // what would be merged before the user confirms. Works without Google —
    // the plan is drawn from local rows and merges stay local-only.
    const auth = await getAuth(userId);
    try {
      const { plan } = await planDedup({ store: ctx.store, googleAuth: auth, userId });
      return plan;
    } catch (err) {
      logger.error({ err }, 'dedup: plan failed');
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(500).send({ error: msg });
    }
  });

  app.post('/api/subjects/dedup', async (req, reply) => {
    const userId = req.userId!;
    // Execute a plan  -  either the one supplied by the client or a fresh
    // one from the agent if `auto: true`.
    const body = req.body as {
      auto?: unknown;
      subjectMerges?: Array<{ fromId?: unknown; intoId?: unknown }>;
      eventMerges?: Array<{ canonicalEventId?: unknown; redundantEventIds?: unknown }>;
    };
    const auth = await getAuth(userId);

    let subjectMerges = (body.subjectMerges ?? []) as Array<{ fromId: string; intoId: string }>;
    let eventMerges = (body.eventMerges ?? []) as Array<{ canonicalEventId: string; redundantEventIds: string[] }>;
    if (body.auto === true) {
      try {
        const { plan } = await planDedup({ store: ctx.store, googleAuth: auth, userId });
        subjectMerges = plan.subjectMerges;
        eventMerges = plan.eventMerges;
      } catch (err) {
        return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
      }
    }

    const summary = { subjectMerges: 0, eventMerges: 0, googleEventsDeleted: 0 };
    for (const m of subjectMerges) {
      if (typeof m.fromId !== 'string' || typeof m.intoId !== 'string') continue;
      try {
        const r = await mergeSubject({
          fromId: m.fromId, intoId: m.intoId,
          store: ctx.store, googleAuth: auth ?? undefined,
          deleteGoogleEvents: auth !== null, userId,
        });
        summary.subjectMerges++;
        summary.googleEventsDeleted += r.googleEventsDeleted;
      } catch (err) {
        logger.error({ err, m }, 'dedup: subject merge failed');
      }
    }
    for (const m of eventMerges) {
      if (typeof m.canonicalEventId !== 'string' || !Array.isArray(m.redundantEventIds)) continue;
      try {
        const r = await mergeEvent({
          canonicalEventId: m.canonicalEventId,
          redundantEventIds: m.redundantEventIds,
          store: ctx.store, googleAuth: auth, userId,
        });
        summary.eventMerges++;
        summary.googleEventsDeleted += r.googleEventsDeleted;
      } catch (err) {
        logger.error({ err, m }, 'dedup: event merge failed');
      }
    }
    return summary;
  });

  app.get('/api/settings/ical-url', async (req) => {
    const userId = req.userId!;
    return { url: await ctx.store.getSetting(ICAL_URL_SETTING, userId) };
  });

  app.put('/api/settings/ical-url', async (req, reply) => {
    const userId = req.userId!;
    const body = req.body as { url?: unknown };
    const raw = typeof body?.url === 'string' ? body.url.trim() : '';
    if (raw === '') {
      await ctx.store.deleteSetting(ICAL_URL_SETTING, userId);
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
    await ctx.store.setSetting(ICAL_URL_SETTING, raw, userId);
    return { url: raw };
  });

  app.post('/api/import/ical', async (req, reply) => {
    const userId = req.userId!;
    const url = await ctx.store.getSetting(ICAL_URL_SETTING, userId);
    if (!url) {
      return reply.code(400).send({ error: 'no iCal URL configured' });
    }
    // Google is optional — with no client the sync writes local rows only.
    const auth = await getAuth(userId);
    // Stream NDJSON so the dashboard can render a real progress bar
    // through fetch + ReadableStream. Bypasses Fastify's serialiser via
    // hijack()  -  we own the response from here on.
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'content-type': 'application/x-ndjson',
      'cache-control': 'no-cache',
      // Tell intermediaries (and the browser) not to buffer.
      'x-accel-buffering': 'no',
    });
    const emit = (evt: IcalProgress) => {
      raw.write(JSON.stringify(evt) + '\n');
    };
    try {
      await runFullIcalSync(url, { googleAuth: auth, store: ctx.store, userId }, emit);
    } catch (err) {
      logger.error({ err }, 'import:ical failed');
      // runFullIcalSync already emits the error event before re-throwing;
      // we just need to terminate the stream cleanly.
    } finally {
      raw.end();
    }
  });

  // ---- CourSys Atom feed (announcements) -------------------------------

  app.get('/api/settings/atom-url', async (req) => {
    const userId = req.userId!;
    return { url: await ctx.store.getSetting(ATOM_URL_SETTING, userId) };
  });

  app.put('/api/settings/atom-url', async (req, reply) => {
    const userId = req.userId!;
    const body = req.body as { url?: unknown };
    const raw = typeof body?.url === 'string' ? body.url.trim() : '';
    if (raw === '') {
      await ctx.store.deleteSetting(ATOM_URL_SETTING, userId);
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
    await ctx.store.setSetting(ATOM_URL_SETTING, raw, userId);
    return { url: raw };
  });

  app.post('/api/import/atom', async (req, reply) => {
    const userId = req.userId!;
    const url = await ctx.store.getSetting(ATOM_URL_SETTING, userId);
    if (!url) {
      return reply.code(400).send({ error: 'no Atom URL configured' });
    }
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'content-type': 'application/x-ndjson',
      'cache-control': 'no-cache',
      'x-accel-buffering': 'no',
    });
    const emit = (evt: AtomProgress) => {
      raw.write(JSON.stringify(evt) + '\n');
    };
    try {
      await syncAtomSubscription(url, { store: ctx.store, userId }, emit);
    } catch (err) {
      logger.error({ err }, 'import:atom failed');
      const message = err instanceof Error ? err.message : String(err);
      try {
        raw.write(JSON.stringify({ stage: 'error', message } satisfies AtomProgress) + '\n');
      } catch {
        /* response may already be closed */
      }
    } finally {
      raw.end();
    }
  });

  app.get('/api/announcements', async (req) => {
    const userId = req.userId!;
    const q = req.query as { subjectId?: string; limit?: string };
    const limit = q.limit ? Math.max(1, Math.min(Number(q.limit) || 200, 1000)) : 200;
    return ctx.store.listAnnouncements(
      { subjectId: q.subjectId, limit },
      userId,
    );
  });

  app.post('/api/import/sfu', async (req, reply) => {
    const userId = req.userId!;
    if (!req.isMultipart()) {
      return reply.code(400).send({ error: 'expected multipart/form-data with a "pdf" file' });
    }
    let pdfBuf: Buffer | null = null;
    let pdfName: string | null = null;
    for await (const part of req.parts()) {
      if (part.type === 'file' && part.fieldname === 'pdf') {
        pdfBuf = await part.toBuffer();
        pdfName = part.filename ?? 'schedule.pdf';
      }
    }
    if (!pdfBuf) {
      return reply.code(400).send({ error: 'missing "pdf" file in form' });
    }
    try {
      const schedule = await parseSchedulePdf(pdfBuf);
      const googleAuth = await getAuth(userId);
      const result = await bootstrapFromSchedule(schedule, {
        googleAuth,
        store: ctx.store,
        userId,
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

  app.post('/api/sync', async (req, reply) => {
    const userId = req.userId!;
    if (ctx.runState.current) {
      return reply
        .code(409)
        .send({ error: 'already running', running: ctx.runState.current });
    }
    const runId = randomUUID();
    const startedAt = new Date().toISOString();
    ctx.runState.current = { runId, startedAt };
    logger.info({ runId, userId }, 'manual sync triggered');

    const child = spawn(
      process.execPath,
      [resolvePath('dist/index.js'), 'run'],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          AUTO_SCHEDULE_NO_JITTER: '1',
          AUTO_SCHEDULE_USER_ID: String(userId),
        },
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

  // --- WhatsApp bot webhook ---------------------------------------------
  //
  // Meta calls GET once at subscribe-time with a hub.challenge it expects us
  // to echo back. Afterwards it POSTs each inbound message + delivery event
  // to the same URL. Both arms read config lazily so the server still boots
  // if WA_* env vars aren't set yet.

  app.get('/bot/whatsapp', async (req, reply) => {
    let cfg;
    try {
      cfg = loadMetaConfig();
    } catch (err) {
      if (err instanceof MetaConfigError) {
        return reply.code(503).send({ error: err.message });
      }
      throw err;
    }
    const result = handleVerifyHandshake(
      req.query as Record<string, unknown>,
      cfg,
    );
    if (!result.ok) {
      logger.warn({ reason: result.reason }, 'whatsapp: verify handshake rejected');
      return reply.code(403).send('forbidden');
    }
    return reply.type('text/plain').send(result.challenge);
  });

  app.post('/bot/whatsapp', async (req, reply) => {
    let cfg;
    try {
      cfg = loadMetaConfig();
    } catch (err) {
      if (err instanceof MetaConfigError) {
        return reply.code(503).send({ error: err.message });
      }
      throw err;
    }
    const sig = req.headers['x-hub-signature-256'];
    const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody;
    if (!rawBody) {
      logger.error('whatsapp: rawBody missing — parser not wired');
      return reply.code(500).send({ error: 'raw body unavailable' });
    }
    if (!verifyWebhookSignature(rawBody, typeof sig === 'string' ? sig : undefined, cfg)) {
      logger.warn('whatsapp: signature verification failed');
      return reply.code(401).send('unauthorized');
    }

    // ACK Meta within ~5s or it'll retry. Process inbound text after the
    // response is sent so a slow LLM call doesn't trigger duplicate webhooks.
    reply.code(200).send('ok');

    const inbound = parseInboundText(req.body);
    if (!inbound) {
      // Delivery / read receipts come through here too — nothing to do.
      return;
    }
    if (inbound.from !== cfg.recipient) {
      logger.warn(
        { from: inbound.from, expected: cfg.recipient },
        'whatsapp: ignoring message from non-allowed number',
      );
      return;
    }
    try {
      // Phase B: route every WA message to user_id=1. Phase E swaps this for a
      // whatsapp_recipients lookup keyed by inbound.from.
      const { reply: out } = await handleIncomingMessage(
        ctx.store,
        inbound.from,
        inbound.text,
        DEFAULT_USER_ID,
      );
      await sendText(inbound.from, out, cfg);
    } catch (err) {
      logger.error({ err, from: inbound.from }, 'whatsapp: reply pipeline failed');
      try {
        await sendText(
          inbound.from,
          'sorry — something went wrong on my end. try again in a moment.',
          cfg,
        );
      } catch {
        /* swallow */
      }
    }
  });
}

/**
 * The cron runs at 08:00 and 20:00 local time (see README). Compute the next
 * occurrence from now so the UI can show "Next sync in ...".
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
