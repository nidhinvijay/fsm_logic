// src/fsmStates.ts

import { PaperTrade } from "./types";

export enum FSMState {
  WAIT_FOR_SIGNAL = 'WAIT_FOR_SIGNAL',

  BUY_SIGNAL = 'BUY_SIGNAL',
  SELL_SIGNAL = 'SELL_SIGNAL',

  BUYENTRY_WINDOW = 'BUYENTRY_WINDOW',
  SELLENTRY_WINDOW = 'SELLENTRY_WINDOW',

  BUYPROFIT_WINDOW = 'BUYPROFIT_WINDOW',
  SELLPROFIT_WINDOW = 'SELLPROFIT_WINDOW',

  WAIT_WINDOW = 'WAIT_WINDOW',

  WAIT_FOR_BUYENTRY = 'WAIT_FOR_BUYENTRY',
  WAIT_FOR_SELLENTRY = 'WAIT_FOR_SELLENTRY',
}

export interface PositionState {
  isOpen: boolean;
  side: 'BUY' | 'SELL' | null;
  entryPrice: number | null;
  openedAt: number | null;
}

export interface FSMContext {
  state: FSMState;

  // Price tracking
  savedBUYLTP?: number;
  savedSELLLTP?: number;

  buyEntryTrigger?: number;
  sellEntryTrigger?: number;

  buyStop?: number;
  sellStop?: number;

  // Timer info
  windowStartTs?: number;
  windowDurationMs?: number;

  // Who sent us into WAIT_WINDOW (ENTRY or PROFIT)
  waitSourceState?: FSMState;

  // Position (for paper trades)
  position: PositionState;

  // ✅ All closed paper trades (must exist!)
  trades: PaperTrade[];

  // To identify instrument
  symbolId: string;
}


