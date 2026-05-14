import postgres, { type Sql } from 'postgres';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../logger.js';

export type DbConnection = Sql;

export function createConnection(connectionString?: string): Sql {
  const url = connectionString ?? process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. Point it at your Neon connection string ' +
        '(use the pooled "-pooler" host if you have one).',
    );
  }
  return postgres(url, {
    // Neon's pooled endpoint requires SSL. Detection is loose on purpose:
    // any neon host or anything that already declares sslmode wins. Local
    // dev against bare Postgres falls through to default behaviour.
    ssl: /neon\.tech|sslmode=require/.test(url) ? 'require' : undefined,
    // Single-process app, no need for a big pool.
    max: Number(process.env.PG_POOL_MAX ?? 10),
    // Prevent silent disconnects on Neon's serverless endpoint (idle ~5min).
    idle_timeout: 30,
  });
}

function migrationsDir(): string {
  // When running via tsx the file lives under src/state/; once built it's
  // under dist/state/. Try the co-located folder first, then fall back to
  // the source tree (so dev `tsx` works even when no build copy has run).
  const here = dirname(fileURLToPath(import.meta.url));
  const colocated = resolve(here, 'migrations');
  try {
    readdirSync(colocated);
    return colocated;
  } catch {
    return resolve(process.cwd(), 'src/state/migrations');
  }
}

/**
 * Apply every SQL file in migrations/ that hasn't been recorded in
 * schema_migrations yet, in lexicographic order. Files are run as a single
 * statement batch — keep each one idempotent (CREATE TABLE IF NOT EXISTS,
 * INSERT ... ON CONFLICT) so reruns are safe.
 */
export async function runMigrations(sql: Sql): Promise<void> {
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename    TEXT PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  const dir = migrationsDir();
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const applied = new Set(
    (await sql<{ filename: string }[]>`SELECT filename FROM schema_migrations`)
      .map((r) => r.filename),
  );

  for (const file of files) {
    if (applied.has(file)) continue;
    const path = resolve(dir, file);
    const body = readFileSync(path, 'utf8');
    logger.info({ file }, 'pg: applying migration');
    await sql.begin(async (tx) => {
      await tx.unsafe(body);
      await tx`INSERT INTO schema_migrations (filename) VALUES (${file})`;
    });
  }
}
