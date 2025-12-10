// src/logger.ts
import winston from 'winston';

const { combine, timestamp, printf, colorize } = winston.format;

const logFormat = printf(info => {
  const ts = (info.timestamp as string) ?? '';
  return `${ts} [${info.level}] ${info.message}`;
});

export const logger = winston.createLogger({
  level: 'debug',
  format: combine(timestamp(), logFormat),
  transports: [
    new winston.transports.Console({
      format: combine(colorize(), timestamp(), logFormat),
    }),
    new winston.transports.File({ filename: 'logs/fsm.log' }),
  ],
});

export const logState = (msg: string, ctx?: unknown): void => {
  if (ctx !== undefined) {
    logger.debug(`${msg} ${JSON.stringify(ctx)}`);
  } else {
    logger.debug(msg);
  }
};
