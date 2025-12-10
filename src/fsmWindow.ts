// src/fsmWindow.ts
import { FSMContext } from './fsmStates';
import { logState } from './logger';

export const startWindow = (
  ctx: FSMContext,
  nowTs: number,
  durationMs = 60_000,
): void => {
  ctx.windowStartTs = nowTs;
  ctx.windowDurationMs = durationMs;
  logState('Window started', {
    symbolId: ctx.symbolId,
    startTs: ctx.windowStartTs,
    durationMs: ctx.windowDurationMs,
  });
};

export const getWindowRemaining = (
  ctx: FSMContext,
  nowTs: number,
): number | null => {
  if (ctx.windowStartTs == null || ctx.windowDurationMs == null) {
    return null;
  }
  const elapsed = nowTs - ctx.windowStartTs;
  const remaining = ctx.windowDurationMs - elapsed;
  return remaining > 0 ? remaining : 0;
};

export const isWindowExpired = (
  ctx: FSMContext,
  nowTs: number,
): boolean => {
  const remaining = getWindowRemaining(ctx, nowTs);
  if (remaining === null) return false;
  const expired = remaining === 0;
  if (expired) {
    logState('Window expired', {
      symbolId: ctx.symbolId,
      startTs: ctx.windowStartTs,
      durationMs: ctx.windowDurationMs,
    });
  }
  return expired;
};
