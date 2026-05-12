import 'dotenv/config';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { resolve, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { StateStore } from '../state/store.js';
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
  const store = new StateStore();
  const runState = makeRunState();
  const app = Fastify({ logger: false });

  app.addHook('onRequest', (req, _reply, done) => {
    logger.info({ method: req.method, url: req.url }, 'http');
    done();
  });

  registerRoutes(app, { store, runState });

  const root = publicDir();
  await app.register(fastifyStatic, {
    root,
    prefix: '/',
    index: ['index.html'],
  });

  // SPA fallback: anything not under /api and not a file → index.html
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api')) {
      return reply.code(404).send({ error: 'not found' });
    }
    return reply.sendFile('index.html');
  });

  process.on('SIGINT', async () => {
    logger.info('SIGINT — shutting down');
    await app.close();
    store.close();
    process.exit(0);
  });
  process.on('SIGTERM', async () => {
    await app.close();
    store.close();
    process.exit(0);
  });

  await app.listen({ host: HOST, port: PORT });
  logger.info({ host: HOST, port: PORT, publicDir: root }, 'auto-schedule UI listening');
}

main().catch((err) => {
  logger.error({ err }, 'server fatal');
  process.exit(1);
});
