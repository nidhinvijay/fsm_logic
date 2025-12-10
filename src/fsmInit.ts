// src/fsmInit.ts
import { FSMState, FSMContext } from './fsmStates';
import { logState } from './logger';

export const createFSM = (symbolId: string): FSMContext => {
  const ctx: FSMContext = {
    state: FSMState.WAIT_FOR_SIGNAL,

    savedBUYLTP: undefined,
    savedSELLLTP: undefined,

    buyEntryTrigger: undefined,
    sellEntryTrigger: undefined,

    buyStop: undefined,
    sellStop: undefined,

    windowStartTs: undefined,
    windowDurationMs: 60_000,  // default 60 seconds

    position: {
      isOpen: false,
      side: null,
      entryPrice: null,
      openedAt: null,
    },

    trades: [],  

    symbolId,
  };

  logState(`FSM created for symbol: ${symbolId}`, { state: ctx.state });
  return ctx;
};
