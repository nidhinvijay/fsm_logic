// src/logger.ts
import winston from 'winston';

const { combine, timestamp, printf, colorize } = winston.format;

// Format timestamp in Indian time (Asia/Kolkata) for readability
const logFormat = printf(info => {
  const tsRaw = (info.timestamp as string) ?? '';
  let tsIst = tsRaw;
  try {
    const d = new Date(tsRaw);
    tsIst = d.toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
  } catch {
    // fall back to raw timestamp on any error
    tsIst = tsRaw;
  }
  return `${tsIst} [${info.level}] ${info.message}`;
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
