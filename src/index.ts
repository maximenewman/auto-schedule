import 'dotenv/config';
import { logger } from './logger.js';
import { StateStore } from './state/store.js';
import { subjects } from './config/subjects.js';
import { runGoogleSetup, getAuthorizedClient } from './auth/google.js';
import { runCourSysSetup } from './auth/coursys.js';
import { upsertEvent } from './sync/calendar.js';
import { runPipeline } from './pipeline.js';

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

async function main(): Promise<void> {
  const command = parseCommand(process.argv);
  logger.info({ command, subjectCount: subjects.length }, 'auto-schedule starting');

  switch (command) {
    case 'run': {
      const store = new StateStore();
      try {
        const googleAuth = await getAuthorizedClient();
        await runPipeline(subjects, { googleAuth, store });
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
            summary: 'auto-schedule: sanity check',
            description:
              'Created by `npm run dev test:calendar`. Safe to delete. Re-running should update, not duplicate.',
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

main().catch((err) => {
  logger.error({ err }, 'fatal');
  process.exit(1);
});
