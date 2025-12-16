import fs from 'fs';
import path from 'path';

function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function csvCell(value: unknown): string {
  // Always quote, escape quotes (via JSON.stringify).
  return JSON.stringify(value ?? '');
}

function appendCsvRow(params: {
  filePath: string;
  header: string;
  cells: unknown[];
}): void {
  try {
    ensureDir(path.dirname(params.filePath));
    const exists = fs.existsSync(params.filePath);
    const line = `${params.cells.map(csvCell).join(',')}\n`;
    if (!exists) fs.appendFileSync(params.filePath, `${params.header}\n${line}`, 'utf8');
    else fs.appendFileSync(params.filePath, line, 'utf8');
  } catch {
    // best-effort only; never break trading flow
  }
}

function minuteKeyIst(tsMs: number): { datePart: string; minuteKey: string } {
  const ist = new Date(tsMs + 5.5 * 60 * 60 * 1000);
  const iso = ist.toISOString();
  const datePart = iso.slice(0, 10);
  const timePart = iso.slice(11, 16);
  return { datePart, minuteKey: `${datePart} ${timePart}` };
}

function captureDir(): string | null {
  const enabled = (process.env.CAPTURE_ENABLED || '').toLowerCase();
  if (enabled === '0' || enabled === 'false' || enabled === 'no') return null;
  const dir = process.env.CAPTURE_DIR || '';
  if (!dir.trim()) return null;
  return dir.trim();
}

export function captureWebhookSignal(params: {
  tsMs: number;
  contentType: string | undefined;
  rawBodyText: string;
  message: string;
  action: 'ENTRY' | 'EXIT' | 'UNKNOWN';
  rawSymbol: string;
  mappedSymbol: string;
  stopPx: number | null;
  routedTo: string | null;
}): void {
  const dir = captureDir();
  if (!dir) return;
  const { datePart, minuteKey } = minuteKeyIst(params.tsMs);
  appendCsvRow({
    filePath: path.join(dir, `signals-${datePart}.csv`),
    header:
      'timeIst,tsMs,action,rawSymbol,mappedSymbol,stopPx,routedTo,message,contentType,rawBody',
    cells: [
      minuteKey,
      params.tsMs,
      params.action,
      params.rawSymbol,
      params.mappedSymbol,
      params.stopPx ?? '',
      params.routedTo ?? '',
      params.message,
      params.contentType ?? '',
      params.rawBodyText,
    ],
  });
}

export function captureZerodhaTick(params: {
  tsMs: number;
  token: number | null;
  symbolId: string | null;
  ltp: number | null;
}): void {
  const dir = captureDir();
  if (!dir) return;
  const { datePart, minuteKey } = minuteKeyIst(params.tsMs);
  appendCsvRow({
    filePath: path.join(dir, `ticks-${datePart}.csv`),
    header: 'timeIst,tsMs,token,symbolId,ltp',
    cells: [minuteKey, params.tsMs, params.token ?? '', params.symbolId ?? '', params.ltp ?? ''],
  });
}

