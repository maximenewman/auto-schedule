import 'dotenv/config';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyMultipart from '@fastify/multipart';
import fastifyCookie from '@fastify/cookie';
import fastifyCors from '@fastify/cors';
import { resolve, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Store } from '../state/store.js';
import { logger } from '../logger.js';
import { registerRoutes, makeRunState } from './routes.js';

const HOST = process.env.SERVER_HOST ?? '127.0.0.1';
const PORT = Number(process.env.SERVER_PORT ?? 5174);

function publicDir(): string {
  // When running via tsx the file lives under src/server/; once built it's
  // under dist/server/. The static SPA in either case sits next to it.
  const here = dirname(fileURLToPath(import.meta.url));
  const colocated = resolve(here, 'public');
  if (existsSync(colocated)) return colocated;
  // Fallback to the source tree when the build hasn't copied public/ yet.
  const sourceCopy = resolve(process.cwd(), 'src/server/public');
  if (existsSync(sourceCopy)) return sourceCopy;
  return colocated; // let Fastify error if neither exists
}

async function main(): Promise<void> {
  const store = await Store.create();
  const runState = makeRunState();
  const app = Fastify({ logger: false });

  app.addHook('onRequest', (req, _reply, done) => {
    logger.info({ method: req.method, url: req.url }, 'http');
    done();
  });

  await app.register(fastifyMultipart, {
    limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  });

  const cookieSecret = process.env.SESSION_SECRET;
  if (!cookieSecret) {
    throw new Error(
      'SESSION_SECRET is not set — generate one with `node -e "console.log(require(\'node:crypto\').randomBytes(32).toString(\'base64\'))"`',
    );
  }
  await app.register(fastifyCookie, { secret: cookieSecret });

  // The companion browser extension POSTs cookies from
  // chrome-extension://<id>. Allow that origin (plus the dev UI origin) with
  // credentials so the session cookie travels on the upload.
  await app.register(fastifyCors, {
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // same-origin / curl / server-to-server
      if (origin.startsWith('chrome-extension://')) return cb(null, true);
      if (origin.startsWith('moz-extension://')) return cb(null, true);
      const allowed = (process.env.CORS_ALLOWED_ORIGINS ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (allowed.includes(origin)) return cb(null, true);
      return cb(null, false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  });

  // Preserve the raw JSON bytes alongside the parsed body. The WhatsApp
  // webhook verifies an HMAC over the exact payload Meta sent, so we can't
  // rely on JSON.stringify(req.body) — re-serialisation re-orders keys and
  // changes whitespace, breaking the signature check.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (req, body, done) => {
      (req as unknown as { rawBody: Buffer }).rawBody = body as Buffer;
      try {
        const text = (body as Buffer).toString('utf8');
        done(null, text.length === 0 ? {} : JSON.parse(text));
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  registerRoutes(app, { store, runState });

  const root = publicDir();
  await app.register(fastifyStatic, {
    root,
    prefix: '/',
    index: ['index.html'],
  });

  // SPA fallback: anything not under /api and not a file -> index.html
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api')) {
      return reply.code(404).send({ error: 'not found' });
    }
    return reply.sendFile('index.html');
  });

  process.on('SIGINT', async () => {
    logger.info('SIGINT  -  shutting down');
    await app.close();
    await store.close();
    process.exit(0);
  });
  process.on('SIGTERM', async () => {
    await app.close();
    await store.close();
    process.exit(0);
  });

  await app.listen({ host: HOST, port: PORT });
  logger.info({ host: HOST, port: PORT, publicDir: root }, 'auto-schedule UI listening');
}

main().catch((err) => {
  logger.error({ err }, 'server fatal');
  process.exit(1);
});
