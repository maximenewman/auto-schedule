import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { logger } from './logger.js';
import { StateStore } from './state/store.js';
import { loadSubjects } from './config/subjectsStore.js';
import { runGoogleSetup, getAuthorizedClient } from './auth/google.js';
import { runCourSysSetup, CourSysAuthError } from './auth/coursys.js';
import { upsertEvent } from './sync/calendar.js';
import { runPipeline } from './pipeline.js';
import { notifyAuthFailure } from './notify/notifier.js';
import { parseSchedulePdf } from './import/sfuPdf.js';
import { bootstrapFromSchedule } from './import/bootstrap.js';
import { runFullIcalSync, ICAL_URL_SETTING } from './import/icalSync.js';

type Command =
  | 'run'
  | 'setup:google'
  | 'setup:coursys'
  | 'test:calendar'
  | 'import:sfu'
  | 'sync:ical';

const COMMANDS: readonly Command[] = [
  'run',
  'setup:google',
  'setup:coursys',
  'test:calendar',
  'import:sfu',
  'sync:ical',
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
  baseFolder: string;
}

function parseImportArgs(argv: string[]): ImportArgs {
  const args = argv.slice(3);
  let pdfPath: string | undefined;
  let baseFolder: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--base-folder') {
      baseFolder = args[++i];
    } else if (a.startsWith('--base-folder=')) {
      baseFolder = a.slice('--base-folder='.length);
    } else if (!pdfPath) {
      pdfPath = a;
    }
  }
  if (!pdfPath) {
    throw new Error('usage: import:sfu <path-to-pdf> [--base-folder <path>]');
  }
  return {
    pdfPath: resolve(pdfPath),
    baseFolder:
      baseFolder ??
      process.env.AUTO_SCHEDULE_BASE_FOLDER ??
      'downloads',
  };
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
  // import:sfu parses its own args and needs to read subjects via the store  - 
  // loading them here would be redundant but it's also the cheapest sanity
  // check that the store boots.
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
    case 'sync:ical': {
      const store = new StateStore();
      try {
        const url = process.argv[3] ?? store.getSetting(ICAL_URL_SETTING);
        if (!url) {
          throw new Error(
            'no iCal URL configured. Pass as arg or save via the UI (Schedule -> iCal subscription).',
          );
        }
        const googleAuth = await getAuthorizedClient();
        const result = await runFullIcalSync(url, { googleAuth, store });
        logger.info(result, 'sync:ical finished');
      } finally {
        store.close();
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
          baseFolder: args.baseFolder,
        },
        'parsed SFU schedule',
      );
      const store = new StateStore();
      try {
        const googleAuth = await getAuthorizedClient();
        const result = await bootstrapFromSchedule(schedule, {
          baseFolder: args.baseFolder,
          googleAuth,
          store,
          sourceLabel: `pdf:${args.pdfPath.split(/[\\/]/).pop()}`,
        });
        logger.info(result, 'import:sfu finished');
      } finally {
        store.close();
      }
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
