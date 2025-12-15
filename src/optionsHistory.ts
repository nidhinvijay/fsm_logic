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
  tradeEntry: number | null;
  tradeExit: number | null;
  tradePnl: number | null;
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

    const [
      timeIst,
      paperCumStr,
      paperRealStr,
      paperUnrlStr,
      liveCumStr,
      liveRealStr,
      liveUnrlStr,
      tradeSideRaw = '',
      tradeEntryStr = '',
      tradeExitStr = '',
      tradePnlStr = '',
    ] = cols;

    rows.push({
      timeIst,
      paperCumPnl: toNum(paperCumStr) ?? 0,
      paperRealized: toNum(paperRealStr) ?? 0,
      paperUnrealized: toNum(paperUnrlStr) ?? 0,
      liveCumPnl: toNum(liveCumStr) ?? 0,
      liveRealized: toNum(liveRealStr) ?? 0,
      liveUnrealized: toNum(liveUnrlStr) ?? 0,
      tradeSide: tradeSideRaw || null,
      tradeEntry: tradeEntryStr ? toNum(tradeEntryStr) : null,
      tradeExit: tradeExitStr ? toNum(tradeExitStr) : null,
      tradePnl: tradePnlStr ? toNum(tradePnlStr) : null,
    });
  }

  return rows;
}

