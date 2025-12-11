// src/fsmProfitWindow.ts
import { FSMContext, FSMState } from './fsmStates';
import { Tick, PaperTrade } from './types';
import { getWindowRemaining, startWindow } from './fsmWindow';
import { logState } from './logger';
import { round2, calcCumPnl } from './pnl';

export const handleTickInProfitWindows = (
  ctx: FSMContext,
  tick: Tick,
): void => {
  if (tick.symbolId !== ctx.symbolId) return;

  if (ctx.state === FSMState.BUYPROFIT_WINDOW) {
    handleBuyProfitWindowTick(ctx, tick);
  } else if (ctx.state === FSMState.SELLPROFIT_WINDOW) {
    handleSellProfitWindowTick(ctx, tick);
  }
};

const moveToWaitFromProfit = (ctx: FSMContext, nowTs: number): void => {
  const remaining = getWindowRemaining(ctx, nowTs) ?? 0;

  ctx.waitSourceState = ctx.state;
  startWindow(ctx, nowTs, remaining);
  ctx.state = FSMState.WAIT_WINDOW;

  logState('Profit window -> WAIT_WINDOW', {
    symbolId: ctx.symbolId,
    from: ctx.waitSourceState,
    remainingMs: remaining,
  });
};

export const closePosition = (
  ctx: FSMContext,
  exitPrice: number,
  exitTs: number,
): void => {
  if (
    !ctx.position.isOpen ||
    ctx.position.side == null ||
    ctx.position.entryPrice == null
  ) {
    logState('closePosition called but no open position', {
      symbolId: ctx.symbolId,
    });
    return;
  }

  const side = ctx.position.side;
  const entry = ctx.position.entryPrice;
  const openedAt = ctx.position.openedAt ?? exitTs;

  const rawPnl = side === 'BUY' ? exitPrice - entry : entry - exitPrice;
  const pnl = round2(rawPnl);

  const trade: PaperTrade = {
    id: `${ctx.symbolId}-${exitTs}`,
    symbolId: ctx.symbolId,
    side,
    entryPrice: entry,
    exitPrice,
    openedAt,
    closedAt: exitTs,
    pnl,
  };

  ctx.trades.push(trade);

  const cumPnl = calcCumPnl(ctx.trades);

  // Reset position
  ctx.position.isOpen = false;
  ctx.position.side = null;
  ctx.position.entryPrice = null;
  ctx.position.openedAt = null;

  logState('Position closed', {
    symbolId: ctx.symbolId,
    side,
    exitPrice,
    pnl,
    cumPnl,        // 🔥 total PnL over all trades
    exitTs,
  });
};

const handleBuyProfitWindowTick = (ctx: FSMContext, tick: Tick): void => {
  if (ctx.buyStop == null) {
    logState('BUYPROFIT_WINDOW missing buyStop', { symbolId: ctx.symbolId });
    return;
  }

  const ltp = tick.ltp;

  // If price ≤ stop → close position → WAIT_WINDOW(remaining of 60 sec)
  if (ltp <= ctx.buyStop) {
    logState('BUYPROFIT_WINDOW stop hit', {
      symbolId: ctx.symbolId,
      ltp,
      stop: ctx.buyStop,
    });

    closePosition(ctx, ltp, tick.ts);
    moveToWaitFromProfit(ctx, tick.ts);
    return;
  }

  // If 60s expires → re-open 60s BUYPROFIT_WINDOW.
  const remaining = getWindowRemaining(ctx, tick.ts);
  if (remaining === 0) {
    startWindow(ctx, tick.ts, 60_000);
    logState('BUYPROFIT_WINDOW renewed for another 60s', {
      symbolId: ctx.symbolId,
    });
  }
};

const handleSellProfitWindowTick = (ctx: FSMContext, tick: Tick): void => {
  if (ctx.sellStop == null) {
    logState('SELLPROFIT_WINDOW missing sellStop', { symbolId: ctx.symbolId });
    return;
  }

  const ltp = tick.ltp;

  // If price ≥ stop → close position → WAIT_WINDOW(remaining of 60 sec)
  if (ltp >= ctx.sellStop) {
    logState('SELLPROFIT_WINDOW stop hit', {
      symbolId: ctx.symbolId,
      ltp,
      stop: ctx.sellStop,
    });

    closePosition(ctx, ltp, tick.ts);
    moveToWaitFromProfit(ctx, tick.ts);
    return;
  }

  // If 60s expires → re-open 60s SELLPROFIT_WINDOW.
  const remaining = getWindowRemaining(ctx, tick.ts);
  if (remaining === 0) {
    startWindow(ctx, tick.ts, 60_000);
    logState('SELLPROFIT_WINDOW renewed for another 60s', {
      symbolId: ctx.symbolId,
    });
  }
};
