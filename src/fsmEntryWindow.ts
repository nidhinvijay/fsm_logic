// src/fsmEntryWindow.ts
import { FSMContext, FSMState } from './fsmStates';
import { Tick } from './types';
import { getWindowRemaining, startWindow } from './fsmWindow';
import { logState } from './logger';
import { onPaperLongOpen, onPaperShortOpen } from './paperHooks';

export const handleTickInEntryWindows = (
  ctx: FSMContext,
  tick: Tick,
): void => {
  if (tick.symbolId !== ctx.symbolId) return;

  if (ctx.state === FSMState.BUYENTRY_WINDOW) {
    handleBuyEntryWindowTick(ctx, tick);
  } else if (ctx.state === FSMState.SELLENTRY_WINDOW) {
    handleSellEntryWindowTick(ctx, tick);
  }
};

const moveToWaitFromEntry = (ctx: FSMContext, nowTs: number): void => {
  const remaining = getWindowRemaining(ctx, nowTs) ?? 0;
  ctx.waitSourceState = ctx.state;
  startWindow(ctx, nowTs, remaining);
  ctx.state = FSMState.WAIT_WINDOW;
  logState('Entry window -> WAIT_WINDOW', {
    symbolId: ctx.symbolId,
    from: ctx.waitSourceState,
    remainingMs: remaining,
  });
};

const handleBuyEntryWindowTick = (ctx: FSMContext, tick: Tick): void => {
  if (ctx.buyStop == null || ctx.buyEntryTrigger == null) {
    logState('BUYENTRY_WINDOW missing triggers', { symbolId: ctx.symbolId });
    return;
  }

  const ltp = tick.ltp;

  // First check stop: price ≤ stop → fail cycle → WAIT_WINDOW(remaining)
  if (ltp <= ctx.buyStop) {
    logState('BUYENTRY_WINDOW stop hit, fail cycle', {
      symbolId: ctx.symbolId,
      ltp,
      stop: ctx.buyStop,
    });
    moveToWaitFromEntry(ctx, tick.ts);
    return;
  }

  // Then check entry: price ≥ trigger → open LONG → BUYPROFIT_WINDOW
  if (!ctx.position.isOpen && ltp >= ctx.buyEntryTrigger) {
    ctx.position.isOpen = true;
    ctx.position.side = 'BUY';
    ctx.position.entryPrice = ltp;
    ctx.position.openedAt = tick.ts;

    startWindow(ctx, tick.ts, 60_000);
    const from = FSMState.BUYENTRY_WINDOW;
    ctx.state = FSMState.BUYPROFIT_WINDOW;

    logState('Open LONG from BUYENTRY_WINDOW', {
      symbolId: ctx.symbolId,
      from,
      to: ctx.state,
      entryPrice: ltp,
      trigger: ctx.buyEntryTrigger,
      stop: ctx.buyStop,
    });

    // 🔥 Notify live LONG engine
    if (onPaperLongOpen && ctx.windowStartTs != null && ctx.windowDurationMs != null) {
      const paperWindowEndTs = ctx.windowStartTs + ctx.windowDurationMs;
      onPaperLongOpen(ctx, tick.ts, paperWindowEndTs, ltp);
    }
  }
};

const handleSellEntryWindowTick = (ctx: FSMContext, tick: Tick): void => {
  if (ctx.sellStop == null || ctx.sellEntryTrigger == null) {
    logState('SELLENTRY_WINDOW missing triggers', { symbolId: ctx.symbolId });
    return;
  }

  const ltp = tick.ltp;

  // First check stop: price ≥ stop → fail cycle → WAIT_WINDOW(remaining)
  if (ltp >= ctx.sellStop) {
    logState('SELLENTRY_WINDOW stop hit, fail cycle', {
      symbolId: ctx.symbolId,
      ltp,
      stop: ctx.sellStop,
    });
    moveToWaitFromEntry(ctx, tick.ts);
    return;
  }

  // Then check entry: price ≤ trigger → open SHORT → SELLPROFIT_WINDOW
  if (!ctx.position.isOpen && ltp <= ctx.sellEntryTrigger) {
    ctx.position.isOpen = true;
    ctx.position.side = 'SELL';
    ctx.position.entryPrice = ltp;
    ctx.position.openedAt = tick.ts;

    startWindow(ctx, tick.ts, 60_000);
    const from = FSMState.SELLENTRY_WINDOW;
    ctx.state = FSMState.SELLPROFIT_WINDOW;

    logState('Open SHORT from SELLENTRY_WINDOW', {
      symbolId: ctx.symbolId,
      from,
      to: ctx.state,
      entryPrice: ltp,
      trigger: ctx.sellEntryTrigger,
      stop: ctx.sellStop,
    });

    // 🔥 Notify live SHORT engine
    if (onPaperShortOpen && ctx.windowStartTs != null && ctx.windowDurationMs != null) {
      const paperWindowEndTs = ctx.windowStartTs + ctx.windowDurationMs;
      onPaperShortOpen(ctx, tick.ts, paperWindowEndTs, ltp);
    }
  }
};
