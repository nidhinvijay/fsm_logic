// src/fsmEngine.ts
import { FSMContext, FSMState } from './fsmStates';
import { Tick, Signal } from './types';
import { handleSignal } from './fsmOnSignal';
import { handleTickFromSignalState } from './fsmSignalTick';
import { handleTickInEntryWindows } from './fsmEntryWindow';
import { handleTickInProfitWindows } from './fsmProfitWindow';
import {
  handleTickInWaitWindow,
  handleTickInWaitForEntryWindows,
} from './fsmWaitAndReentry';
import { logState } from './logger';

// Call this when a BUY/SELL signal arrives
export const onSignal = (ctx: FSMContext, signal: Signal): void => {
  handleSignal(ctx, signal);
};

// Call this for every price tick
export const onTick = (ctx: FSMContext, tick: Tick): void => {
  if (tick.symbolId !== ctx.symbolId) return;

  switch (ctx.state) {
    case FSMState.BUY_SIGNAL:
    case FSMState.SELL_SIGNAL:
      handleTickFromSignalState(ctx, tick);
      break;

    case FSMState.BUYENTRY_WINDOW:
    case FSMState.SELLENTRY_WINDOW:
      handleTickInEntryWindows(ctx, tick);
      break;

    case FSMState.BUYPROFIT_WINDOW:
    case FSMState.SELLPROFIT_WINDOW:
      handleTickInProfitWindows(ctx, tick);
      break;

    case FSMState.WAIT_WINDOW:
      handleTickInWaitWindow(ctx, tick);
      break;

    case FSMState.WAIT_FOR_BUYENTRY:
    case FSMState.WAIT_FOR_SELLENTRY:
      handleTickInWaitForEntryWindows(ctx, tick);
      break;

    case FSMState.WAIT_FOR_SIGNAL:
      // No special tick logic here for now
      break;

    default:
      logState('Unknown FSM state on tick', {
        symbolId: ctx.symbolId,
        state: ctx.state,
      });
      break;
  }
};
