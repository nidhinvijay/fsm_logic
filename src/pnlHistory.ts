import fs from 'fs';
import path from 'path';

export interface PnlHistoryRow {
  timeIst: string;
  paperLongCumPnl: number;
  paperShortCumPnl: number;
  liveLongCumPnl: number;
  liveShortCumPnl: number;
  tradeSide: string | null;
  tradeEntry: number | null;
  tradeExit: number | null;
  tradePnl: number | null;
}

export function loadPnlHistory(dateKey: string): PnlHistoryRow[] {
  // dateKey should be YYYY-MM-DD (same as filename suffix)
  const filePath = path.join('logs', `pnl-${dateKey}.csv`);

  if (!fs.existsSync(filePath)) {
    return [];
  }

  const raw = fs.readFileSync(filePath, 'utf8').trim();
  if (!raw) return [];

  const lines = raw.split('\n');
  if (lines.length <= 1) return [];

  const rows: PnlHistoryRow[] = [];

  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;

    const cols = line.split(',');
    if (cols.length < 5) continue;

    const [
      timeIst,
      paperLongStr,
      paperShortStr,
      liveLongStr,
      liveShortStr,
      tradeSideRaw = '',
      tradeEntryStr = '',
      tradeExitStr = '',
      tradePnlStr = '',
    ] = cols;

    const toNum = (s: string): number | null => {
      const v = parseFloat(s);
      return Number.isNaN(v) ? null : v;
    };

    rows.push({
      timeIst,
      paperLongCumPnl: toNum(paperLongStr) ?? 0,
      paperShortCumPnl: toNum(paperShortStr) ?? 0,
      liveLongCumPnl: toNum(liveLongStr) ?? 0,
      liveShortCumPnl: toNum(liveShortStr) ?? 0,
      tradeSide: tradeSideRaw || null,
      tradeEntry: tradeEntryStr ? toNum(tradeEntryStr) : null,
      tradeExit: tradeExitStr ? toNum(tradeExitStr) : null,
      tradePnl: tradePnlStr ? toNum(tradePnlStr) : null,
    });
  }

  return rows;
}

