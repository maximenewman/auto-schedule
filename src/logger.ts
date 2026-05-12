import pino from 'pino';
import { resolve } from 'node:path';

const level = process.env.LOG_LEVEL ?? 'info';
const json = process.env.LOG_JSON === '1';
const logFile = process.env.LOG_FILE;
const isTty = process.stdout.isTTY === true;

const prettyOptions = {
  translateTime: 'SYS:yyyy-mm-dd HH:MM:ss',
  ignore: 'pid,hostname',
};

const stdoutTarget: pino.TransportTargetOptions = json
  ? { target: 'pino/file', options: { destination: 1 }, level }
  : {
      target: 'pino-pretty',
      options: { ...prettyOptions, colorize: isTty, destination: 1 },
      level,
    };

const targets: pino.TransportTargetOptions[] = [stdoutTarget];

if (logFile) {
  const abs = resolve(logFile);
  targets.push(
    json
      ? { target: 'pino/file', options: { destination: abs, mkdir: true }, level }
      : {
          target: 'pino-pretty',
          options: { ...prettyOptions, colorize: false, destination: abs, mkdir: true },
          level,
        },
  );
}

export const logger = pino({ level }, pino.transport({ targets }));
export type Logger = typeof logger;
