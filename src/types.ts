// src/types.ts
export type Side = 'BUY' | 'SELL';

export interface Tick {
  symbolId: string;      // e.g. "BTCUSD" or "NIFTY-25D02-26000-CE"
  ltp: number;          // last traded price
  ts: number;           // timestamp in ms
}

export interface Signal {
  symbolId: string;
  side: Side;
  ts: number;
}

export interface PaperTrade {
  id: string;
  symbolId: string;
  side: Side;          // BUY = long, SELL = short
  entryPrice: number;
  exitPrice?: number;
  openedAt: number;
  closedAt?: number;
  pnl?: number;      // <-- add this

}
