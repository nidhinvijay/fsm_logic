import { InstrumentInfo, getInstrumentByToken } from './instruments';

export interface ZerodhaTick {
  token: number;
  ltp: number;
  ts: number;
}

export interface ResolvedZerodhaTick {
  instrument: InstrumentInfo;
  symbolId: string;
  ltp: number;
  ts: number;
}

export function resolveZerodhaTick(tick: ZerodhaTick): ResolvedZerodhaTick | null {
  const instrument = getInstrumentByToken(tick.token);
  if (!instrument) return null;
  return {
    instrument,
    symbolId: instrument.tradingview,
    ltp: tick.ltp,
    ts: tick.ts,
  };
}