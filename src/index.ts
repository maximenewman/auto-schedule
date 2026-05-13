import 'dotenv/config';
import { logger } from './logger.js';
import { StateStore } from './state/store.js';
import { loadSubjects } from './config/subjectsStore.js';
import { runGoogleSetup, getAuthorizedClient } from './auth/google.js';
import { runCourSysSetup, CourSysAuthError } from './auth/coursys.js';
import { upsertEvent } from './sync/calendar.js';
import { runPipeline } from './pipeline.js';
import { notifyAuthFailure } from './notify/notifier.js';

type Command =
  | 'run'
  | 'setup:google'
  | 'setup:coursys'
  | 'test:calendar';

const COMMANDS: readonly Command[] = [
  'run',
  'setup:google',
  'setup:coursys',
  'test:calendar',
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

async function maybeJitter(command: Command): Promise<void> {
  if (command !== 'run') return;
  if (process.env.AUTO_SCHEDULE_NO_JITTER === '1') return;
  const ms = Math.floor(Math.random() * 60_000);
  logger.info({ jitterMs: ms }, 'jittering before run');
  await new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  const command = parseCommand(process.argv);
  await maybeJitter(command);
  const subjects = loadSubjects();
  logger.info(
    { command, subjectCount: subjects.length, pid: process.pid },
    'auto-schedule starting',
  );

  switch (command) {
    case 'run': {
      const store = new StateStore();
      try {
        const googleAuth = await getAuthorizedClient();
        try {
          await runPipeline(subjects, { googleAuth, store });
        } catch (err) {
          if (err instanceof CourSysAuthError) {
            await notifyAuthFailure('coursys', googleAuth, err.message);
            process.exitCode = 2;
            return;
          }
          throw err;
        }
      } finally {
        store.close();
      }
      return;
    }
    case 'setup:google': {
      await runGoogleSetup();
      return;
    }
    case 'setup:coursys': {
      await runCourSysSetup();
      return;
    }
    case 'test:calendar': {
      const store = new StateStore();
      try {
        const auth = await getAuthorizedClient();
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
        );
        logger.info({ result }, 'test:calendar finished');
      } finally {
        store.close();
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
