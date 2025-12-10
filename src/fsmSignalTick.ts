// src/fsmSignalTick.ts
import { FSMContext, FSMState } from './fsmStates';
import { Tick } from './types';
import { startWindow } from './fsmWindow';
import { logState } from './logger';

export const handleTickFromSignalState = (ctx: FSMContext, tick: Tick): void => {
  // Ignore ticks for other symbols
  if (tick.symbolId !== ctx.symbolId) return;

  if (ctx.state === FSMState.BUY_SIGNAL) {
    onFirstTickAfterBuySignal(ctx, tick);
  } else if (ctx.state === FSMState.SELL_SIGNAL) {
    onFirstTickAfterSellSignal(ctx, tick);
  }
};

const onFirstTickAfterBuySignal = (ctx: FSMContext, tick: Tick): void => {
  const from = ctx.state;

  // From spec:
  // savedBUYLTP = TickLtp
  // BuyEntry-trigger = savedBUYLTP + 0.5
  // stop-loss = savedBUYLTP - 0.5
  ctx.savedBUYLTP = tick.ltp;
  ctx.buyEntryTrigger = ctx.savedBUYLTP + 0.5;
  ctx.buyStop = ctx.savedBUYLTP - 0.5;

  // Start BUYENTRY_WINDOW (60s)
  startWindow(ctx, tick.ts, 60_000);
  ctx.state = FSMState.BUYENTRY_WINDOW;

  logState('Transition BUY_SIGNAL -> BUYENTRY_WINDOW', {
    symbolId: ctx.symbolId,
    from,
    to: ctx.state,
    savedBUYLTP: ctx.savedBUYLTP,
    buyEntryTrigger: ctx.buyEntryTrigger,
    buyStop: ctx.buyStop,
    tickLtp: tick.ltp,
    ts: tick.ts,
  });
};

const onFirstTickAfterSellSignal = (ctx: FSMContext, tick: Tick): void => {
  const from = ctx.state;

  // From spec:
  // savedSELLLTP = TickLtp
  // SellEntry-trigger = savedSELLLTP - 0.5
  // stop-loss = savedSELLLTP + 0.5
  ctx.savedSELLLTP = tick.ltp;
  ctx.sellEntryTrigger = ctx.savedSELLLTP - 0.5;
  ctx.sellStop = ctx.savedSELLLTP + 0.5;

  // Start SELLENTRY_WINDOW (60s)
  startWindow(ctx, tick.ts, 60_000);
  ctx.state = FSMState.SELLENTRY_WINDOW;

  logState('Transition SELL_SIGNAL -> SELLENTRY_WINDOW', {
    symbolId: ctx.symbolId,
    from,
    to: ctx.state,
    savedSELLLTP: ctx.savedSELLLTP,
    sellEntryTrigger: ctx.sellEntryTrigger,
    sellStop: ctx.sellStop,
    tickLtp: tick.ltp,
    ts: tick.ts,
  });
};
