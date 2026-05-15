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
  coursysCookieAge,
  type SyncStatus,
} from './status.js';
import { parseSchedulePdf } from '../import/sfuPdf.js';
import { bootstrapFromSchedule } from '../import/bootstrap.js';
import { syncIcalSubscription, runFullIcalSync, ICAL_URL_SETTING, type IcalProgress } from '../import/icalSync.js';
import { mergeSubject, mergeEvent } from '../import/dedup.js';
import { planDedup } from '../import/dedupAgent.js';
import { getAuthorizedClient } from '../auth/google.js';
import { listGoogleEvents } from '../sync/calendarRead.js';
import type { OAuth2Client } from 'google-auth-library';
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
import { isValidCookie } from '../auth/coursys.js';
import {
  SESSION_COOKIE,
  cookieOptions,
  endSession,
  resolveSession,
  startSession,
} from '../auth/sessions.js';
import { randomBytes } from 'node:crypto';

declare module 'fastify' {
  interface FastifyRequest {
    userId?: number;
  }
}

const OAUTH_STATE_COOKIE = 'as_oauth_state';

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

function isProtectedPath(url: string): boolean {
  // Strip query string for the prefix match. We protect /api/* (the dashboard
  // backend) but leave /auth/* (the login flow), /bot/* (Meta webhook, which
  // verifies via HMAC instead), and the static SPA + index.html open.
  const path = url.split('?')[0]!;
  return path.startsWith('/api/');
}

export function registerRoutes(app: FastifyInstance, ctx: RouteCtx): void {
  // Session resolution: every request gets a chance to attach req.userId.
  // Protected routes 401 when it's still undefined after this hook runs.
  app.addHook('preHandler', async (req, reply) => {
    const cookie = req.cookies?.[SESSION_COOKIE];
    if (cookie) {
      const unsigned = req.unsignCookie(cookie);
      if (unsigned.valid && unsigned.value) {
        const userId = await resolveSession(ctx.store, unsigned.value);
        if (userId !== null) {
          req.userId = userId;
        }
      }
    }
    if (req.userId === undefined && isProtectedPath(req.url)) {
      return reply.code(401).send({ error: 'not authenticated' });
    }
  });

  // ---- auth flow -------------------------------------------------------

  app.get('/auth/google/start', async (_req, reply) => {
    const state = randomBytes(16).toString('base64url');
    reply.setCookie(OAUTH_STATE_COOKIE, state, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/auth/google/callback',
      maxAge: 600,
      signed: true,
    });
    return reply.redirect(buildGoogleAuthUrl(state));
  });

  app.get('/auth/google/callback', async (req, reply) => {
    const q = req.query as { code?: string; state?: string; error?: string };
    if (q.error) {
      return reply.code(400).send({ error: `google: ${q.error}` });
    }
    if (!q.code || !q.state) {
      return reply.code(400).send({ error: 'missing code or state' });
    }
    const signedState = req.cookies?.[OAUTH_STATE_COOKIE];
    if (!signedState) {
      return reply.code(400).send({ error: 'oauth state cookie missing' });
    }
    const unsigned = req.unsignCookie(signedState);
    if (!unsigned.valid || unsigned.value !== q.state) {
      return reply.code(400).send({ error: 'oauth state mismatch' });
    }
    reply.clearCookie(OAUTH_STATE_COOKIE, { path: '/auth/google/callback' });

    let result;
    try {
      result = await exchangeCodeForTokens(q.code);
    } catch (err) {
      logger.error({ err }, 'auth: token exchange failed');
      return reply.code(500).send({ error: 'token exchange failed' });
    }

    const user = await ctx.store.findOrCreateUserByGoogleSub({
      sub: result.profile.sub,
      email: result.profile.email,
      displayName: result.profile.name,
    });
    await ctx.store.saveGoogleTokens(user.id, {
      refreshToken: result.credentials.refresh_token ?? null,
      accessToken: result.credentials.access_token ?? null,
      accessTokenExpires: result.credentials.expiry_date
        ? new Date(result.credentials.expiry_date)
        : null,
      scope: result.credentials.scope ?? null,
    });

    const { sessionId, expiresAt } = await startSession(ctx.store, user.id);
    reply.setCookie(SESSION_COOKIE, sessionId, cookieOptions(expiresAt));
    logger.info({ userId: user.id, email: user.email }, 'auth: signed in');
    return reply.redirect('/');
  });

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

  // ---- CourSys cookie upload ------------------------------------------

  app.get('/api/coursys/cookies', async (req) => {
    const userId = req.userId!;
    const row = await ctx.store.getCourSysCookies(userId);
    if (!row) return { configured: false, count: 0, updatedAt: null };
    return {
      configured: row.cookies.length > 0,
      count: row.cookies.length,
      updatedAt: row.updatedAt ? row.updatedAt.toISOString() : null,
    };
  });

  app.post('/api/coursys/cookies', async (req, reply) => {
    const userId = req.userId!;
    const body = req.body as { consent?: unknown; cookies?: unknown };
    if (body.consent !== true) {
      return reply.code(400).send({
        error:
          'consent required — confirm you understand the app uses these cookies to act on your CourSys session',
      });
    }
    if (!Array.isArray(body.cookies)) {
      return reply.code(400).send({ error: 'cookies must be an array' });
    }
    const valid = body.cookies.filter(isValidCookie);
    if (valid.length === 0) {
      return reply.code(400).send({
        error:
          'no usable cookies in payload — expected objects with name + value strings',
      });
    }
    await ctx.store.saveCourSysCookies(userId, valid);
    logger.info({ userId, count: valid.length }, 'coursys: cookies uploaded');
    return { configured: true, count: valid.length };
  });

  app.delete('/api/coursys/cookies', async (req) => {
    const userId = req.userId!;
    await ctx.store.clearCourSysCookies(userId);
    return { configured: false };
  });

  app.post('/auth/logout', async (req, reply) => {
    const cookie = req.cookies?.[SESSION_COOKIE];
    if (cookie) {
      const unsigned = req.unsignCookie(cookie);
      if (unsigned.valid && unsigned.value) {
        await endSession(ctx.store, unsigned.value);
      }
    }
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
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
    if (!auth) return [];
    try {
      return await listGoogleEvents(auth, ctx.store, { ...opts, userId });
    } catch (err) {
      logger.error({ err, userId }, 'google calendar read failed');
      return [];
    }
  }

  app.get('/api/subjects', async (req) => {
    const userId = req.userId!;
    const now = new Date().toISOString();
    const subjects = await loadSubjects(ctx.store, userId);
    const events = await readEvents(userId, { fromISO: now });
    return subjects.map((s) => {
      const subjectEvents = events.filter((e) => e.subjectId === s.id);
      const upcomingDeadlines = subjectEvents.filter(
        (e) => e.kind === 'assignment' || e.kind === 'midterm' || e.kind === 'exam',
      );
      return {
        ...serializeSubject(s),
        counts: {
          upcomingDeadlines: upcomingDeadlines.length,
          // `files` left at 0 so existing dashboard widgets keep rendering;
          // attachment downloads return in a later phase backed by object
          // storage rather than a local folder.
          files: 0,
          sources: s.sources.length,
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
      await deleteSubject(ctx.store, id, userId);
      return reply.code(204).send();
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
    const cookie = await safe('coursysCookieAge', () =>
      coursysCookieAge(ctx.store, userId),
      { ok: false, expiresInDays: null });
    const googleOk = await safe('googleAuthExists', () =>
      googleAuthExists(ctx.store, userId), false);

    return {
      lastRunISO: lastRun?.finishedAt ?? null,
      nextRunISO: nextCronISO(),
      itemsAddedLastRun,
      itemsAddedLastWeek: itemsLastWeek,
      agentErrorsLastWeek: countRecentAgentErrors(),
      googleAuthOk: googleOk,
      coursysAuthOk: cookie.ok,
      coursysExpiresInDays: cookie.expiresInDays,
      running: ctx.runState.current,
      lastRun: ctx.runState.lastRun,
    };
  });

  app.get('/api/subjects/dedup', async (req, reply) => {
    const userId = req.userId!;
    // Ask the LLM for a dedup plan. Returned as-is so the UI can preview
    // what would be merged before the user confirms.
    const auth = await getAuth(userId);
    if (!auth) {
      return reply.code(503).send({ error: 'google auth not set up' });
    }
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
    if (!auth) {
      return reply.code(503).send({ error: 'google auth not set up' });
    }

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
          store: ctx.store, googleAuth: auth, deleteGoogleEvents: true, userId,
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
    const auth = await getAuth(userId);
    if (!auth) {
      return reply.code(503).send({ error: 'google auth not set up' });
    }
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

  app.post('/api/import/sfu', async (req, reply) => {
    const userId = req.userId!;
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
      const googleAuth = await getAuthorizedClient(ctx.store, userId);
      const result = await bootstrapFromSchedule(schedule, {
        baseFolder,
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
