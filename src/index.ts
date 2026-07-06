import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { logger } from './logger.js';
import { DEFAULT_USER_ID, Store } from './state/store.js';
import { getAuthorizedClient, GoogleAuthMissing } from './auth/google.js';
import type { OAuth2Client } from 'google-auth-library';
import { upsertEvent } from './sync/calendar.js';
import { runPipeline } from './pipeline.js';
import { parseSchedulePdf } from './import/sfuPdf.js';
import { bootstrapFromSchedule } from './import/bootstrap.js';
import { runFullIcalSync, ICAL_URL_SETTING } from './import/icalSync.js';
import { sendDailyDigest } from './bot/daily.js';

type Command =
  | 'run'
  | 'test:calendar'
  | 'import:sfu'
  | 'sync:ical'
  | 'notify:daily';

const COMMANDS: readonly Command[] = [
  'run',
  'test:calendar',
  'import:sfu',
  'sync:ical',
  'notify:daily',
];

function parseCommand(argv: string[]): Command {
  const arg = argv[2];
  if (!arg) {
    throw new Error(
      `missing command. usage: node dist/index.js <${COMMANDS.join('|')}>`,
    );
  }
  if (!COMMANDS.includes(arg as Command)) {
    throw new Error(
      `unknown command "${arg}". expected one of: ${COMMANDS.join(', ')}`,
    );
  }
  return arg as Command;
}

interface ImportArgs {
  pdfPath: string;
}

function parseImportArgs(argv: string[]): ImportArgs {
  const pdfPath = argv.slice(3).find((a) => !a.startsWith('--'));
  if (!pdfPath) {
    throw new Error('usage: import:sfu <path-to-pdf>');
  }
  return { pdfPath: resolve(pdfPath) };
}

async function maybeJitter(command: Command): Promise<void> {
  if (command !== 'run') return;
  if (process.env.AUTO_SCHEDULE_NO_JITTER === '1') return;
  const ms = Math.floor(Math.random() * 60_000);
  logger.info({ jitterMs: ms }, 'jittering before run');
  await new Promise((r) => setTimeout(r, ms));
}

/** Google Calendar is optional — a user without it still syncs locally. */
async function optionalGoogleAuth(
  store: Store,
  userId: number,
): Promise<OAuth2Client | null> {
  try {
    return await getAuthorizedClient(store, userId);
  } catch (err) {
    if (err instanceof GoogleAuthMissing) {
      logger.info({ userId }, 'google not connected — syncing local rows only');
      return null;
    }
    throw err;
  }
}

function pickUserId(): number {
  const raw = process.env.AUTO_SCHEDULE_USER_ID;
  if (!raw) return DEFAULT_USER_ID;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`AUTO_SCHEDULE_USER_ID must be a positive integer, got "${raw}"`);
  }
  return n;
}

async function main(): Promise<void> {
  const command = parseCommand(process.argv);
  await maybeJitter(command);
  const userId = pickUserId();
  logger.info({ command, userId, pid: process.pid }, 'auto-schedule starting');

  switch (command) {
    case 'run': {
      const store = await Store.create();
      try {
        // Single-user when AUTO_SCHEDULE_USER_ID is set (the dashboard's
        // "Sync now" spawn path); otherwise every registered user in turn —
        // that's what the cloud scheduler invokes.
        const userIds = process.env.AUTO_SCHEDULE_USER_ID
          ? [userId]
          : (await store.listUsers()).map((u) => u.id);
        for (const uid of userIds) {
          try {
            const googleAuth = await optionalGoogleAuth(store, uid);
            await runPipeline({ googleAuth, store, userId: uid });
          } catch (err) {
            logger.error({ err, userId: uid }, 'run: pipeline failed for user');
          }
        }
      } finally {
        await store.close();
      }
      return;
    }
    case 'sync:ical': {
      const store = await Store.create();
      try {
        const url = process.argv[3] ?? (await store.getSetting(ICAL_URL_SETTING, userId));
        if (!url) {
          throw new Error(
            'no iCal URL configured. Pass as arg or save via the UI (Schedule -> iCal subscription).',
          );
        }
        const googleAuth = await optionalGoogleAuth(store, userId);
        const result = await runFullIcalSync(url, { googleAuth, store, userId });
        logger.info(result, 'sync:ical finished');
      } finally {
        await store.close();
      }
      return;
    }
    case 'import:sfu': {
      const args = parseImportArgs(process.argv);
      const buf = readFileSync(args.pdfPath);
      const schedule = await parseSchedulePdf(buf);
      logger.info(
        {
          pdf: args.pdfPath,
          term: schedule.term.label,
          courses: schedule.courses.length,
        },
        'parsed SFU schedule',
      );
      const store = await Store.create();
      try {
        const googleAuth = await optionalGoogleAuth(store, userId);
        const result = await bootstrapFromSchedule(schedule, {
          googleAuth,
          store,
          userId,
          sourceLabel: `pdf:${args.pdfPath.split(/[\\/]/).pop()}`,
        });
        logger.info(result, 'import:sfu finished');
      } finally {
        await store.close();
      }
      return;
    }
    case 'notify:daily': {
      const store = await Store.create();
      try {
        const result = await sendDailyDigest(store, userId);
        logger.info(result, 'notify:daily finished');
      } finally {
        await store.close();
      }
      return;
    }
    case 'test:calendar': {
      const store = await Store.create();
      try {
        const auth = await getAuthorizedClient(store, userId);
        const now = new Date();
        const start = new Date(now.getTime() + 60 * 60 * 1000);
        const end = new Date(start.getTime() + 30 * 60 * 1000);
        const result = await upsertEvent(
          auth,
          'test',
          {
            itemId: 'sanity-check',
            kind: 'other',
            summary: 'auto-schedule: sanity check',
            description:
              'Created by `npm run dev test:calendar`. Safe to delete. Re-running should update, not duplicate.',
            room: null,
            startDateTime: start.toISOString(),
            endDateTime: end.toISOString(),
            attachments: [],
          },
          store,
          undefined,
          userId,
        );
        logger.info({ result }, 'test:calendar finished');
      } finally {
        await store.close();
      }
      return;
    }
  }
}

main()
  .then(() => {
    logger.info({ exitCode: process.exitCode ?? 0 }, 'auto-schedule done');
  })
  .catch((err) => {
    logger.error({ err }, 'fatal');
    process.exit(1);
  });
