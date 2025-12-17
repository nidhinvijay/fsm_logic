export interface InstrumentInfo {
  tradingview: string;
  exchange: string;
  zerodha: string;
  token: number;
  lot: number;
}

export const INSTRUMENTS_DATA: InstrumentInfo[] = [
  {
    tradingview: 'NIFTY251223C25900',
    exchange: 'NFO',
    zerodha: 'NIFTY25D2325900CE',
    token: 14591490,
    lot: 75,
  },
  {
    tradingview: 'NIFTY251223P25950',
    exchange: 'NFO',
    zerodha: 'NIFTY25D2325950PE',
    token: 14593026,
    lot: 75,
  },
  {
    tradingview: 'BANKNIFTY251230C59100',
    exchange: 'NFO',
    zerodha: 'BANKNIFTY25DEC59100CE',
    token: 13162498,
    lot: 35,
  },
  {
    tradingview: 'BANKNIFTY251230P59200',
    exchange: 'NFO',
    zerodha: 'BANKNIFTY25DEC59200PE',
    token: 13163778,
    lot: 35,
  },
  {
    tradingview: 'BSX251218C84700',
    exchange: 'BFO',
    zerodha: 'SENSEX25D1884700CE',
    token: 293363461,
    lot: 20,
  },
  {
    tradingview: 'BSX251218P84800',
    exchange: 'BFO',
    zerodha: 'SENSEX25D1884800PE',
    token: 293216261,
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
