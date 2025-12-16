import fs from 'fs';
import path from 'path';
import { INSTRUMENTS_DATA, getInstrumentByTradingViewSymbol } from '../src/instruments';
import { OptionsRuntimeManager } from '../src/optionsRuntime';
import { resolveZerodhaTick } from '../src/zerodhaFeed';

type ReplayEvent =
  | { kind: 'SIGNAL'; tsMs: number; symbolId: string; action: 'ENTRY' | 'EXIT' }
  | { kind: 'TICK'; tsMs: number; symbolId: string; ltp: number; token?: number };

function usage(): never {
  // eslint-disable-next-line no-console
  console.log(
    [
      'Usage:',
      '  ts-node scripts/replayOptions.ts --date YYYY-MM-DD [--symbol TV_SYMBOL] [--captureDir logs/capture]',
      '',
      'Input files (written by in-FSM capture logging or captureProxy):',
      '  <captureDir>/signals-YYYY-MM-DD.csv',
      '  <captureDir>/ticks-YYYY-MM-DD.csv',
      '',
      'Output:',
      '  Creates a new folder under replay-output/ and writes generated options CSVs there.',
    ].join('\n'),
  );
  process.exit(2);
}

function getArg(flag: string): string | null {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return null;
  return process.argv[idx + 1] ?? null;
}

function parseCsvLines(filePath: string): string[][] {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, 'utf8').trim();
  if (!raw) return [];
  const lines = raw.split('\n');
  if (lines.length <= 1) return [];

  const out: string[][] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    // Our capture CSV always uses JSON.stringify for each cell, joined by commas.
    // Parse it by wrapping into an array: [cell1,cell2,...]
    try {
      // eslint-disable-next-line no-eval
      const cells = JSON.parse(`[${line}]`) as unknown[];
      out.push(cells.map((c) => String(c ?? '')));
    } catch {
      // Skip malformed rows.
    }
  }
  return out;
}

function toNum(value: string): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function loadEvents(params: {
  captureDir: string;
  date: string;
  symbolFilter: string | null;
}): ReplayEvent[] {
  const signalsPath = path.join(params.captureDir, `signals-${params.date}.csv`);
  const ticksPath = path.join(params.captureDir, `ticks-${params.date}.csv`);

  const events: ReplayEvent[] = [];

  for (const row of parseCsvLines(signalsPath)) {
    // Supported formats:
    // - in-FSM captureLogger:
    //   timeIst,tsMs,action,rawSymbol,mappedSymbol,stopPx,routedTo,message,contentType,rawBody
    // - legacy captureProxy:
    //   timeIst,tsMs,action,symbol,message,contentType
    const tsMs = toNum(row[1] || '') ?? null;
    const actionRaw = (row[2] || '').toUpperCase();
    if (!tsMs) continue;
    if (actionRaw !== 'ENTRY' && actionRaw !== 'EXIT') continue;

    let sym = '';
    if (row.length >= 10) {
      // in-FSM capture: prefer mappedSymbol
      sym = String(row[4] || '').trim();
    } else {
      // legacy proxy capture
      sym = String(row[3] || '').trim();
    }

    if (!sym) continue;
    if (params.symbolFilter && sym !== params.symbolFilter) continue;
    if (!getInstrumentByTradingViewSymbol(sym)) continue; // options only

    events.push({ kind: 'SIGNAL', tsMs, symbolId: sym, action: actionRaw });
  }

  for (const row of parseCsvLines(ticksPath)) {
    // header: timeIst,tsMs,token,symbolId,ltp
    const tsMs = toNum(row[1] || '') ?? null;
    const token = toNum(row[2] || '');
    const symbolIdRaw = (row[3] || '').trim();
    const ltp = toNum(row[4] || '') ?? null;
    if (!tsMs || ltp == null) continue;

    let symbolId = symbolIdRaw;
    if (!symbolId && token != null) {
      const resolved = resolveZerodhaTick({ token, ltp, ts: tsMs });
      if (resolved) symbolId = resolved.symbolId;
    }
    if (!symbolId) continue;
    if (params.symbolFilter && symbolId !== params.symbolFilter) continue;
    if (!getInstrumentByTradingViewSymbol(symbolId)) continue;

    events.push({
      kind: 'TICK',
      tsMs,
      symbolId,
      ltp,
      token: token ?? undefined,
    });
  }

  events.sort((a, b) => a.tsMs - b.tsMs);
  return events;
}

async function main() {
  const date = getArg('--date');
  const captureDir = getArg('--captureDir') ?? path.join('logs', 'capture');
  const symbolFilter = getArg('--symbol');

  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) usage();

  const runId = `${date}-${Date.now()}`;
  const outDir = path.join('replay-output', runId);
  ensureDir(outDir);

  // Prevent touching production logs when replaying: write into replay-output/<runId>/logs/
  process.chdir(outDir);
  ensureDir('logs');

  const manager = new OptionsRuntimeManager(INSTRUMENTS_DATA);
  const events = loadEvents({ captureDir: path.resolve(captureDir), date, symbolFilter });

  // eslint-disable-next-line no-console
  console.log(`Loaded ${events.length} events for ${date}${symbolFilter ? ` (${symbolFilter})` : ''}`);

  for (const ev of events) {
    if (ev.kind === 'SIGNAL') {
      manager.handleTvSignal(ev.symbolId, ev.action, ev.tsMs);
    } else {
      manager.handleTickBySymbol(ev.symbolId, ev.ltp, ev.tsMs);
    }
  }

  const snaps = manager.getSnapshots();
  fs.writeFileSync('snapshots.json', JSON.stringify({ date, symbolFilter, snaps }, null, 2), 'utf8');

  // eslint-disable-next-line no-console
  console.log(`Replay complete. Output in ${path.resolve('.')}`);
}

// eslint-disable-next-line @typescript-eslint/no-floating-promises
main();
