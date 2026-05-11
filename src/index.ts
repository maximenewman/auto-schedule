import 'dotenv/config';
import { logger } from './logger.js';
import { StateStore } from './state/store.js';
import { subjects } from './config/subjects.js';

type Command = 'run' | 'setup:google' | 'setup:coursys';

const COMMANDS: readonly Command[] = ['run', 'setup:google', 'setup:coursys'];

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
        logger.info('pipeline placeholder — wired in later steps');
        // Pipeline assembly happens once Step 5 lands.
      } finally {
        store.close();
      }
      return;
    }
    case 'setup:google': {
      logger.info('setup:google not yet implemented — see Step 2');
      return;
    }
    case 'setup:coursys': {
      logger.info('setup:coursys not yet implemented — see Step 6');
      return;
    }
  }
}

main().catch((err) => {
  logger.error({ err }, 'fatal');
  process.exit(1);
});
