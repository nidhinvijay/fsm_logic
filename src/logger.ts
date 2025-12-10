// src/logger.ts
import winston from 'winston';

const { combine, timestamp, printf, colorize } = winston.format;

const logFormat = printf(info => {
  const ts = (info.timestamp as string) ?? '';
  return `${ts} [${info.level}] ${info.message}`;
});

// Simple in-memory log buffer for UI (last N FSM logs)
const MAX_IN_MEMORY_LOGS = 500;
const inMemoryLogs: string[] = [];

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
  const line =
    ctx !== undefined ? `${msg} ${JSON.stringify(ctx)}` : msg;

  logger.debug(line);

  // also push into in-memory buffer for UI
  inMemoryLogs.push(line);
  if (inMemoryLogs.length > MAX_IN_MEMORY_LOGS) {
    inMemoryLogs.shift();
  }
};

export const getRecentLogs = (): string[] => {
  return inMemoryLogs;
};
