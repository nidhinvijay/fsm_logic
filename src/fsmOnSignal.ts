// src/fsmOnSignal.ts
import { FSMContext, FSMState } from './fsmStates';
import { Signal } from './types';
import { logState } from './logger';

export const handleSignal = (ctx: FSMContext, signal: Signal): void => {
  if (signal.symbolId !== ctx.symbolId) return;

  if (signal.side === 'BUY') {
    handleBuySignal(ctx, signal.ts);
  } else {
    handleSellSignal(ctx, signal.ts);
  }
};

const handleBuySignal = (ctx: FSMContext, ts: number): void => {
  const from = ctx.state;

  if (from === FSMState.WAIT_FOR_SIGNAL || from === FSMState.WAIT_FOR_BUYENTRY) {
    ctx.state = FSMState.BUY_SIGNAL;
    ctx.windowStartTs = undefined;
    logState('BUY_SIGNAL entered', { symbolId: ctx.symbolId, from, ts });
  } else {
    logState('BUY signal ignored in state', { symbolId: ctx.symbolId, state: from, ts });
  }
};

const handleSellSignal = (ctx: FSMContext, ts: number): void => {
  const from = ctx.state;

  if (from === FSMState.WAIT_FOR_SIGNAL || from === FSMState.WAIT_FOR_SELLENTRY) {
    ctx.state = FSMState.SELL_SIGNAL;
    ctx.windowStartTs = undefined;
    logState('SELL_SIGNAL entered', { symbolId: ctx.symbolId, from, ts });
  } else {
    logState('SELL signal ignored in state', { symbolId: ctx.symbolId, state: from, ts });
  }
};
