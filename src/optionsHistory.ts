import fs from 'fs';
import path from 'path';

export interface OptionsPnlHistoryRow {
  timeIst: string;
  paperCumPnl: number;
  paperRealized: number;
  paperUnrealized: number;
  liveCumPnl: number;
  liveRealized: number;
  liveUnrealized: number;
  tradeSide: string | null;
  tradeOpenedAtMs: number | null;
  tradeEntry: number | null;
  tradeExit: number | null;
  tradePnl: number | null;
  liveTradeOpenedAtMs: number | null;
  liveTradeEntry: number | null;
  liveTradeExit: number | null;
  liveTradePnl: number | null;
  liveTradeCumAfter: number | null;
}

function safeFilePart(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '_');
}

export function loadOptionsHistory(params: {
  tradingview: string;
  dateKey: string; // YYYY-MM-DD
}): OptionsPnlHistoryRow[] {
  const { tradingview, dateKey } = params;

  if (!tradingview) return [];
  const filePath = path.join('logs', `options-${safeFilePart(tradingview)}-${dateKey}.csv`);

  if (!fs.existsSync(filePath)) return [];

  const raw = fs.readFileSync(filePath, 'utf8').trim();
  if (!raw) return [];

  const lines = raw.split('\n');
  if (lines.length <= 1) return [];

  const rows: OptionsPnlHistoryRow[] = [];

  const toNum = (s: string): number | null => {
    const v = parseFloat(s);
    return Number.isNaN(v) ? null : v;
  };

  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;

    const cols = line.split(',');
    if (cols.length < 7) continue;

    // Backward compatible parsing:
    // v1: timeIst,paperCum,paperReal,paperUnrl,liveCum,liveReal,liveUnrl,tradeSide,tradeEntry,tradeExit,tradePnl
    // v2: v1 + liveTradeEntry,liveTradeExit,liveTradePnl,liveTradeCumAfter
    // v3: v2 + tradeOpenedAtMs + liveTradeOpenedAtMs (and re-ordered columns)
    const timeIst = cols[0];
    const paperCumStr = cols[1];
    const paperRealStr = cols[2];
    const paperUnrlStr = cols[3];
    const liveCumStr = cols[4];
    const liveRealStr = cols[5];
    const liveUnrlStr = cols[6];

    let tradeSideRaw = '';
    let tradeOpenedAtMsStr = '';
    let tradeEntryStr = '';
    let tradeExitStr = '';
    let tradePnlStr = '';
    let liveTradeOpenedAtMsStr = '';
    let liveTradeEntryStr = '';
    let liveTradeExitStr = '';
    let liveTradePnlStr = '';
    let liveTradeCumAfterStr = '';

    if (cols.length >= 17) {
      // v3
      tradeSideRaw = cols[7] ?? '';
      tradeOpenedAtMsStr = cols[8] ?? '';
      tradeEntryStr = cols[9] ?? '';
      tradeExitStr = cols[10] ?? '';
      tradePnlStr = cols[11] ?? '';
      liveTradeOpenedAtMsStr = cols[12] ?? '';
      liveTradeEntryStr = cols[13] ?? '';
      liveTradeExitStr = cols[14] ?? '';
      liveTradePnlStr = cols[15] ?? '';
      liveTradeCumAfterStr = cols[16] ?? '';
    } else if (cols.length >= 15) {
      // v2
      tradeSideRaw = cols[7] ?? '';
      tradeEntryStr = cols[8] ?? '';
      tradeExitStr = cols[9] ?? '';
      tradePnlStr = cols[10] ?? '';
      liveTradeEntryStr = cols[11] ?? '';
      liveTradeExitStr = cols[12] ?? '';
      liveTradePnlStr = cols[13] ?? '';
      liveTradeCumAfterStr = cols[14] ?? '';
    } else if (cols.length >= 11) {
      // v1
      tradeSideRaw = cols[7] ?? '';
      tradeEntryStr = cols[8] ?? '';
      tradeExitStr = cols[9] ?? '';
      tradePnlStr = cols[10] ?? '';
    }

    rows.push({
      timeIst,
      paperCumPnl: toNum(paperCumStr) ?? 0,
      paperRealized: toNum(paperRealStr) ?? 0,
      paperUnrealized: toNum(paperUnrlStr) ?? 0,
      liveCumPnl: toNum(liveCumStr) ?? 0,
      liveRealized: toNum(liveRealStr) ?? 0,
      liveUnrealized: toNum(liveUnrlStr) ?? 0,
      tradeSide: tradeSideRaw || null,
      tradeOpenedAtMs: tradeOpenedAtMsStr ? toNum(tradeOpenedAtMsStr) : null,
      tradeEntry: tradeEntryStr ? toNum(tradeEntryStr) : null,
      tradeExit: tradeExitStr ? toNum(tradeExitStr) : null,
      tradePnl: tradePnlStr ? toNum(tradePnlStr) : null,
      liveTradeOpenedAtMs: liveTradeOpenedAtMsStr ? toNum(liveTradeOpenedAtMsStr) : null,
      liveTradeEntry: liveTradeEntryStr ? toNum(liveTradeEntryStr) : null,
      liveTradeExit: liveTradeExitStr ? toNum(liveTradeExitStr) : null,
      liveTradePnl: liveTradePnlStr ? toNum(liveTradePnlStr) : null,
      liveTradeCumAfter: liveTradeCumAfterStr ? toNum(liveTradeCumAfterStr) : null,
    });
  }

  return rows;
}
