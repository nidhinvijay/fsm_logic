// src/pnl.ts
import { PaperTrade } from './types';

// Round to 2 decimal places
export const round2 = (value: number): number =>
  Math.round(value * 100) / 100;

// Cumulative PnL over all closed trades
export const calcCumPnl = (trades: PaperTrade[]): number => {
  const total = trades.reduce((sum, t) => {
    const pnl = t.pnl ?? 0;
    return sum + pnl;
  }, 0);

  return round2(total);
};
