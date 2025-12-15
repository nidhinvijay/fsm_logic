export interface InstrumentInfo {
  tradingview: string;
  exchange: string;
  zerodha: string;
  token: number;
  lot: number;
}

export const INSTRUMENTS_DATA: InstrumentInfo[] = [
  {
    tradingview: 'NIFTY251216C26050',
    exchange: 'NFO',
    zerodha: 'NIFTY25D1626050CE',
    token: 12345858,
    lot: 75,
  },
  {
    tradingview: 'NIFTY251216P26100',
    exchange: 'NFO',
    zerodha: 'NIFTY25D1626100PE',
    token: 12346626,
    lot: 75,
  },
  {
    tradingview: 'BANKNIFTY251230C59400',
    exchange: 'NFO',
    zerodha: 'BANKNIFTY25DEC59400CE',
    token: 13173762,
    lot: 35,
  },
  {
    tradingview: 'BANKNIFTY251230P59500',
    exchange: 'NFO',
    zerodha: 'BANKNIFTY25DEC59500PE',
    token: 13177858,
    lot: 35,
  },
  {
    tradingview: 'BSX251218C85300',
    exchange: 'BFO',
    zerodha: 'SENSEX25D1885300CE',
    token: 291220997,
    lot: 20,
  },
  {
    tradingview: 'BSX251218P85400',
    exchange: 'BFO',
    zerodha: 'SENSEX25D1885400PE',
    token: 293306629,
    lot: 20,
  },
];

const byTradingView = new Map<string, InstrumentInfo>(
  INSTRUMENTS_DATA.map((i) => [i.tradingview, i]),
);
const byToken = new Map<number, InstrumentInfo>(
  INSTRUMENTS_DATA.map((i) => [i.token, i]),
);

export function getInstrumentByTradingViewSymbol(
  symbol: string,
): InstrumentInfo | undefined {
  return byTradingView.get(symbol);
}

export function getInstrumentByToken(token: number): InstrumentInfo | undefined {
  return byToken.get(token);
}

