import pino from 'pino';

const level = process.env.LOG_LEVEL ?? 'info';
const isTty = process.stdout.isTTY === true;

export const logger = pino(
  isTty
    ? {
        level,
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:standard' },
        },
      }
    : { level },
);

export type Logger = typeof logger;
