// src/fsmWaitAndReentry.ts
import { FSMContext, FSMState } from './fsmStates';
import { Tick } from './types';
import { getWindowRemaining, startWindow } from './fsmWindow';
import { logState } from './logger';

// ---------- WAIT_WINDOW ----------

export const handleTickInWaitWindow = (ctx: FSMContext, tick: Tick): void => {
  if (tick.symbolId !== ctx.symbolId) return;
  if (ctx.state !== FSMState.WAIT_WINDOW) return;

  const remaining = getWindowRemaining(ctx, tick.ts);

  // Still in cooldown
  if (remaining === null || remaining > 0) {
    return;
  }

  // Cooldown finished, decide where to go next
  const from = ctx.waitSourceState;

  if (from === FSMState.BUYENTRY_WINDOW) {
    // Go back to BUYENTRY_WINDOW with a fresh 60s window
    ctx.state = FSMState.BUYENTRY_WINDOW;
    startWindow(ctx, tick.ts, 60_000);
    logState('WAIT_WINDOW -> BUYENTRY_WINDOW', { symbolId: ctx.symbolId });
    return;
  }

  if (from === FSMState.SELLENTRY_WINDOW) {
    // Go back to SELLENTRY_WINDOW with a fresh 60s window
    ctx.state = FSMState.SELLENTRY_WINDOW;
    startWindow(ctx, tick.ts, 60_000);
    logState('WAIT_WINDOW -> SELLENTRY_WINDOW', { symbolId: ctx.symbolId });
    return;
  }

  if (from === FSMState.BUYPROFIT_WINDOW) {
    // After profit wait, go to WAIT_FOR_BUYENTRY(60s)
    ctx.state = FSMState.WAIT_FOR_BUYENTRY;
    startWindow(ctx, tick.ts, 60_000);
    logState('WAIT_WINDOW -> WAIT_FOR_BUYENTRY', { symbolId: ctx.symbolId });
    return;
  }

  if (from === FSMState.SELLPROFIT_WINDOW) {
    // After profit wait, go to WAIT_FOR_SELLENTRY(60s)
    ctx.state = FSMState.WAIT_FOR_SELLENTRY;
    startWindow(ctx, tick.ts, 60_000);
    logState('WAIT_WINDOW -> WAIT_FOR_SELLENTRY', { symbolId: ctx.symbolId });
    return;
  }

  // If somehow waitSourceState is missing, just go to WAIT_FOR_SIGNAL
  ctx.state = FSMState.WAIT_FOR_SIGNAL;
  logState('WAIT_WINDOW finished with unknown source, going to WAIT_FOR_SIGNAL', {
    symbolId: ctx.symbolId,
  });
};

// ---------- WAIT_FOR_BUYENTRY / WAIT_FOR_SELLENTRY ----------

export const handleTickInWaitForEntryWindows = (
  ctx: FSMContext,
  tick: Tick,
): void => {
  if (tick.symbolId !== ctx.symbolId) return;

  if (ctx.state === FSMState.WAIT_FOR_BUYENTRY) {
    handleWaitForBuyEntryTick(ctx, tick);
  } else if (ctx.state === FSMState.WAIT_FOR_SELLENTRY) {
    handleWaitForSellEntryTick(ctx, tick);
  }
};

const handleWaitForBuyEntryTick = (ctx: FSMContext, tick: Tick): void => {
  if (ctx.buyEntryTrigger == null || ctx.buyStop == null || ctx.savedBUYLTP == null) {
    logState('WAIT_FOR_BUYENTRY missing buy data', { symbolId: ctx.symbolId });
    return;
  }

  const ltp = tick.ltp;

  // If price ≥ BuyEntry-trigger → open LONG, switch to BUYPROFIT_WINDOW
  if (!ctx.position.isOpen && ltp >= ctx.buyEntryTrigger) {
    ctx.position.isOpen = true;
    ctx.position.side = 'BUY';
    ctx.position.entryPrice = ltp;
    ctx.position.openedAt = tick.ts;

    ctx.state = FSMState.BUYPROFIT_WINDOW;
    startWindow(ctx, tick.ts, 60_000);

    logState('WAIT_FOR_BUYENTRY -> open LONG -> BUYPROFIT_WINDOW', {
      symbolId: ctx.symbolId,
      entryPrice: ltp,
      trigger: ctx.buyEntryTrigger,
      stop: ctx.buyStop,
    });
    return;
  }

  // If 60s expires → re-open 60s WAIT_FOR_BUYENTRY
  const remaining = getWindowRemaining(ctx, tick.ts);
  if (remaining === 0) {
    startWindow(ctx, tick.ts, 60_000);
    logState('WAIT_FOR_BUYENTRY renewed for another 60s', {
      symbolId: ctx.symbolId,
    });
  }
};

const handleWaitForSellEntryTick = (ctx: FSMContext, tick: Tick): void => {
  if (ctx.sellEntryTrigger == null || ctx.sellStop == null || ctx.savedSELLLTP == null) {
    logState('WAIT_FOR_SELLENTRY missing sell data', { symbolId: ctx.symbolId });
    return;
  }

  const ltp = tick.ltp;

  // If price ≤ SellEntry-trigger → open SHORT, switch to SELLPROFIT_WINDOW
  if (!ctx.position.isOpen && ltp <= ctx.sellEntryTrigger) {
    ctx.position.isOpen = true;
    ctx.position.side = 'SELL';
    ctx.position.entryPrice = ltp;
    ctx.position.openedAt = tick.ts;

    ctx.state = FSMState.SELLPROFIT_WINDOW;
    startWindow(ctx, tick.ts, 60_000);

    logState('WAIT_FOR_SELLENTRY -> open SHORT -> SELLPROFIT_WINDOW', {
      symbolId: ctx.symbolId,
      entryPrice: ltp,
      trigger: ctx.sellEntryTrigger,
      stop: ctx.sellStop,
    });
    return;
  }

  // If 60s expires → re-open 60s WAIT_FOR_SELLENTRY
  const remaining = getWindowRemaining(ctx, tick.ts);
  if (remaining === 0) {
    startWindow(ctx, tick.ts, 60_000);
    logState('WAIT_FOR_SELLENTRY renewed for another 60s', {
      symbolId: ctx.symbolId,
    });
  }
};
