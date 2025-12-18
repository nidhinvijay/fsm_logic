import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { KiteConnect } from 'kiteconnect';
import { createFSM } from './fsmInit';
import { onSignal, onTick } from './fsmEngine';
import { FSMContext } from './fsmStates';
import { round2, calcCumPnl } from './pnl';
import {
  createLiveContext,
  onPaperEntryOpportunity,
  onLiveTick,
  forceExitIfCumPnlNonPositive,
  tryOpenLiveFromPaperPosition,
} from './liveEngine';
import { LiveContext, LiveState } from './liveStates';
import { PaperTrade } from './types';
import {
  registerPaperLongOpen,
  registerPaperShortOpen,
} from './paperHooks';
import { getRecentLogs, logState } from './logger';
import { closePosition } from './fsmProfitWindow';
import { loadPnlHistory } from './pnlHistory';
import { INSTRUMENTS_DATA, getInstrumentByTradingViewSymbol } from './instruments';
import { OptionsRuntimeManager } from './optionsRuntime';
import { loadOptionsHistory } from './optionsHistory';
import { resolveZerodhaTick } from './zerodhaFeed';
import { loadEnvOnce } from './loadEnv';
import { captureWebhookSignal, captureZerodhaTick } from './captureLogger';
import { getOptionsExecutionState, setOptionsExecutionEnabled } from './optionsExecution';
import { startDeltaFeed } from './deltaFeed';

loadEnvOnce();

const app = express();
app.use(
  cors({
    origin: ['https://pnlgraph.web.app', 'https://localhost:4200'],
    credentials: true,
  }),
);
// Webhooks can arrive as `text/plain`, `application/json`, or sometimes without a reliable content-type.
// Parse `/webhook` as text first so we can handle all of those uniformly.
app.use('/webhook', express.text({ type: '*/*' }));
app.use(express.json());
app.use(express.static('public'));

function upsertEnvLine(contents: string, key: string, value: string): string {
  const lines = contents.split(/\r?\n/);
  const prefix = `${key}=`;
  let found = false;

  const next = lines.map((line) => {
    if (line.startsWith(prefix)) {
      found = true;
      return `${key}=${value}`;
    }
    return line;
  });

  if (!found) {
    if (next.length && next[next.length - 1].trim() !== '') next.push('');
    next.push(`${key}=${value}`);
  }

  return next.join('\n');
}

function writeZerodhaEnv(params: {
  envPath: string;
  apiKey: string;
  apiSecret: string;
  accessToken: string;
}): void {
  const existing = fs.existsSync(params.envPath)
    ? fs.readFileSync(params.envPath, 'utf8')
    : '';
  let updated = existing;
  updated = upsertEnvLine(updated, 'KITE_API_KEY', params.apiKey);
  updated = upsertEnvLine(updated, 'KITE_API_SECRET', params.apiSecret);
  updated = upsertEnvLine(updated, 'KITE_ACCESS_TOKEN', params.accessToken);
  updated = upsertEnvLine(
    updated,
    'KITE_ACCESS_TOKEN_GENERATED_AT_UTC',
    new Date().toISOString(),
  );

  fs.writeFileSync(params.envPath, updated, 'utf8');
}

// --- Recent incoming signals (for UI) ---

interface RecentSignalRow {
  tsUtc: string;
  tsIst: string;
  source: 'TradingView' | 'Manual';
  httpPath: '/webhook' | '/signal';
  rawMessage?: string;
  parsedAction?: 'ENTRY' | 'EXIT' | null;
  stopPx?: number | null;
  rawSymbol?: string | null;
  symbol?: string | null;
  routedTo?: 'PAPER_LONG_BUY' | 'PAPER_SHORT_SELL' | 'OPTIONS' | 'IGNORED' | null;
  note?: string | null;
}

const recentSignals: RecentSignalRow[] = [];
const MAX_RECENT_SIGNALS = 250;

function toIstIso(tsMs: number): string {
  return new Date(tsMs + 5.5 * 60 * 60 * 1000).toISOString();
}

function pushRecentSignal(row: RecentSignalRow): void {
  recentSignals.push(row);
  if (recentSignals.length > MAX_RECENT_SIGNALS) {
    recentSignals.splice(0, recentSignals.length - MAX_RECENT_SIGNALS);
  }
}

// --- Paper FSMs (separate BUY + SELL) ---

// BUY side (LONG paper FSM)
let paperLongCtx: FSMContext = createFSM('BTCUSD');
// SELL side (SHORT paper FSM)
let paperShortCtx: FSMContext = createFSM('BTCUSD');

// --- Indian Options runtimes (per instrument) ---
const optionsManager = new OptionsRuntimeManager(INSTRUMENTS_DATA);

// --- Live FSMs (LONG + SHORT) ---

let liveLongCtx: LiveContext = createLiveContext('BTCUSD-LONG');
let liveShortCtx: LiveContext = createLiveContext('BTCUSD-SHORT');

// --- Live realized PnL tracking (per side) ---

let liveLongCumPnl = 0;
let liveShortCumPnl = 0;

let liveLongEntryPrice: number | null = null;
let liveShortEntryPrice: number | null = null;

function getLiveLongPnl() {
  const realized = liveLongCumPnl;
  let unrealized = 0;
  if (liveLongEntryPrice != null) {
    unrealized = currentPrice - liveLongEntryPrice;
  }
  const unrealizedRounded = round2(unrealized);
  return {
    realized,
    unrealized: unrealizedRounded,
    total: round2(realized + unrealizedRounded),
  };
}

function getLiveShortPnl() {
  const realized = liveShortCumPnl;
  let unrealized = 0;
  if (liveShortEntryPrice != null) {
    unrealized = liveShortEntryPrice - currentPrice;
  }
  const unrealizedRounded = round2(unrealized);
  return {
    realized,
    unrealized: unrealizedRounded,
    total: round2(realized + unrealizedRounded),
  };
}

// --- External live trading webhook (Bharath) ---

const LIVE_WEBHOOK_URL =
  'https://asia-south1-delta-6c4a8.cloudfunctions.net/tradingviewWebhook?token=tradingview';

async function sendLiveWebhookMessage(
  kind: 'ENTRY' | 'EXIT',
  symbol: string,
  refPrice: number,
): Promise<void> {
  // Build a TradingView-style message string.
  const message =
    kind === 'ENTRY'
      ? `Accepted Entry + priorRisePct= 0.00 | stopPx=${refPrice} | sym=${symbol}`
      : `Accepted Exit + priorRisePct= 0.00 | stopPx=${refPrice} | sym=${symbol}`;

  try {
    logState('Sending live webhook', { kind, symbol, refPrice, message });

    await fetch(LIVE_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    });

    logState('Live webhook sent to Firebase', {
      kind,
      symbol,
      refPrice,
    });
  } catch (err) {
    logState('Failed to call live webhook', {
      kind,
      symbol,
      refPrice,
      error: String(err),
    });
  }
}

// Helpers to open/close live trades and maintain realized cum PnL per side.

type LiveTradeRow = {
  tsIst: string;
  tsUtc: string;
  side: 'LONG' | 'SHORT';
  action: 'OPEN' | 'CLOSE';
  entryPrice: number | null;
  exitPrice: number | null;
  tradePnl: number | null;
  cumPnlAfter: number;
};

const MAX_LIVE_TRADE_EVENTS = 200;
const liveTradeEvents: LiveTradeRow[] = [];

function pushLiveTradeEvent(e: LiveTradeRow): void {
  liveTradeEvents.push(e);
  if (liveTradeEvents.length > MAX_LIVE_TRADE_EVENTS) {
    liveTradeEvents.splice(0, liveTradeEvents.length - MAX_LIVE_TRADE_EVENTS);
  }
}

function openLiveLong(entryPrice: number): void {
  const now = Date.now();
  liveLongEntryPrice = entryPrice;
  if (!liveLongCtx.position.openedAt) liveLongCtx.position.openedAt = now;
  pushLiveTradeEvent({
    tsUtc: new Date(now).toISOString(),
    tsIst: toIstIso(now),
    side: 'LONG',
    action: 'OPEN',
    entryPrice,
    exitPrice: null,
    tradePnl: null,
    cumPnlAfter: liveLongCumPnl,
  });
  void sendLiveWebhookMessage('ENTRY', 'BTCUSD', entryPrice);
}

function closeLiveLong(exitPrice: number): void {
  const now = Date.now();
  const entry = liveLongEntryPrice;
  let pnl: number | null = null;
  if (liveLongEntryPrice != null) {
    pnl = round2(exitPrice - liveLongEntryPrice);
    liveLongCumPnl = round2(liveLongCumPnl + pnl);
  }
  liveLongEntryPrice = null;
  pushLiveTradeEvent({
    tsUtc: new Date(now).toISOString(),
    tsIst: toIstIso(now),
    side: 'LONG',
    action: 'CLOSE',
    entryPrice: entry,
    exitPrice,
    tradePnl: pnl,
    cumPnlAfter: liveLongCumPnl,
  });
  void sendLiveWebhookMessage('EXIT', 'BTCUSD', exitPrice);
}

function openLiveShort(entryPrice: number): void {
  const now = Date.now();
  liveShortEntryPrice = entryPrice;
  if (!liveShortCtx.position.openedAt) liveShortCtx.position.openedAt = now;
  pushLiveTradeEvent({
    tsUtc: new Date(now).toISOString(),
    tsIst: toIstIso(now),
    side: 'SHORT',
    action: 'OPEN',
    entryPrice,
    exitPrice: null,
    tradePnl: null,
    cumPnlAfter: liveShortCumPnl,
  });
  // Open SHORT → SELL
  void sendLiveWebhookMessage('EXIT', 'BTCUSD', entryPrice);
}

function closeLiveShort(exitPrice: number): void {
  const now = Date.now();
  const entry = liveShortEntryPrice;
  let pnl: number | null = null;
  if (liveShortEntryPrice != null) {
    pnl = round2(liveShortEntryPrice - exitPrice);
    liveShortCumPnl = round2(liveShortCumPnl + pnl);
  }
  liveShortEntryPrice = null;
  pushLiveTradeEvent({
    tsUtc: new Date(now).toISOString(),
    tsIst: toIstIso(now),
    side: 'SHORT',
    action: 'CLOSE',
    entryPrice: entry,
    exitPrice,
    tradePnl: pnl,
    cumPnlAfter: liveShortCumPnl,
  });
  // Close SHORT → BUY
  void sendLiveWebhookMessage('ENTRY', 'BTCUSD', exitPrice);
}

// --- Price feed mode + simulation state ---

type FeedMode = 'DELTA' | 'SIM';
type AutoMode = 'PAUSE' | 'UP' | 'DOWN' | 'RANDOM';

let feedMode: FeedMode = 'DELTA'; // default = live Delta feed
let autoMode: AutoMode = 'PAUSE'; // used only in SIM mode

let currentPrice = 100;
const TICK_STEP = 0.5;
const SIM_INTERVAL_MS = 1000;
let lastBtcTickTs: number | null = null;
let lastBtcMarketPrice: number | null = null;
let lastBtcMarketTickTs: number | null = null;
let lastBtcResetPrice: number | null = null;
let lastBtcResetTs: number | null = null;

// BTC paper trailing stop:
// Keep initial FSM stop logic (savedLTP ± 0.5), then tighten stop once a position is open.
const BTC_TRAIL_STOP_POINTS = 4;
let btcLongTrailHigh: number | null = null;
let btcShortTrailLow: number | null = null;

function applyBtcTrailingStopsBeforeTick(ltp: number): void {
  // LONG paper (BUY)
  if (paperLongCtx.position.isOpen && paperLongCtx.position.side === 'BUY') {
    if (btcLongTrailHigh != null) {
      btcLongTrailHigh = Math.max(btcLongTrailHigh, ltp);
      const trailStop = btcLongTrailHigh - BTC_TRAIL_STOP_POINTS;
      paperLongCtx.buyStop =
        paperLongCtx.buyStop != null
          ? Math.max(paperLongCtx.buyStop, trailStop)
          : trailStop;
    }
  }

  // SHORT paper (SELL)
  if (paperShortCtx.position.isOpen && paperShortCtx.position.side === 'SELL') {
    if (btcShortTrailLow != null) {
      btcShortTrailLow = Math.min(btcShortTrailLow, ltp);
      const trailStop = btcShortTrailLow + BTC_TRAIL_STOP_POINTS;
      paperShortCtx.sellStop =
        paperShortCtx.sellStop != null
          ? Math.min(paperShortCtx.sellStop, trailStop)
          : trailStop;
    }
  }
}

function syncBtcTrailingStateAfterTick(): void {
  // Initialize trailing anchors after a position opens (entry happens inside onTick).
  if (paperLongCtx.position.isOpen && paperLongCtx.position.side === 'BUY') {
    if (btcLongTrailHigh == null) {
      btcLongTrailHigh = paperLongCtx.position.entryPrice ?? currentPrice;
    }
  } else {
    btcLongTrailHigh = null;
  }

  if (paperShortCtx.position.isOpen && paperShortCtx.position.side === 'SELL') {
    if (btcShortTrailLow == null) {
      btcShortTrailLow = paperShortCtx.position.entryPrice ?? currentPrice;
    }
  } else {
    btcShortTrailLow = null;
  }
}

// Track last day (in IST) when we ran daily reset
let lastDailyResetIstDate: string | null = null;

// Track last seen trade counts so we can detect newly closed trades
let lastLongTradeCount = paperLongCtx.trades.length;
let lastShortTradeCount = paperShortCtx.trades.length;

// helper: per-side live PnL (realized + unrealized on currentPrice)
function getSideLivePnl(ctx: FSMContext) {
  const realized = calcCumPnl(ctx.trades);

  let unrealized = 0;
  if (ctx.position.isOpen && ctx.position.entryPrice != null) {
    const entry = ctx.position.entryPrice;
    if (ctx.position.side === 'BUY') {
      unrealized = currentPrice - entry;
    } else if (ctx.position.side === 'SELL') {
      unrealized = entry - currentPrice;
    }
  }
  const unrealizedRounded = round2(unrealized);
  const total = round2(realized + unrealizedRounded);

  return {
    realized,
    unrealized: unrealizedRounded,
    total,
  };
}

// helper: total live cum PnL from both paper engines
function getTotalCumPnl(): number {
  const long = getSideLivePnl(paperLongCtx);
  const short = getSideLivePnl(paperShortCtx);
  return round2(long.total + short.total);
}

interface PnlSnapshot {
  kind: 'TRADE_CLOSE' | 'DAILY_RESET' | 'MINUTE';
  symbol: string;
  eventTsUtc: string;
  eventTsIst: string;
  paperLongCumPnl: number;
  paperShortCumPnl: number;
  cumPnlTotal: number;
  // live cum PnL should match paper semantics: realized + unrealized (on currentPrice)
  liveLongCumPnl: number;
  liveShortCumPnl: number;
  trade?: {
    side: 'BUY' | 'SELL';
    entryPrice: number;
    exitPrice: number;
    pnl: number;
    openedAt: number;
    closedAt: number;
  };
}

function buildPnlSnapshot(
  kind: PnlSnapshot['kind'],
  eventTsMs: number,
  trade?: PaperTrade,
): PnlSnapshot {
  const utc = new Date(eventTsMs);
  const ist = new Date(eventTsMs + 5.5 * 60 * 60 * 1000);

  const longPnl = getSideLivePnl(paperLongCtx);
  const shortPnl = getSideLivePnl(paperShortCtx);
  const totalCumPnl = round2(longPnl.total + shortPnl.total);

  const liveLong = getLiveLongPnl();
  const liveShort = getLiveShortPnl();

  const tradePayload =
    trade && trade.entryPrice != null && trade.exitPrice != null && trade.pnl != null
      ? {
          side: trade.side,
          entryPrice: trade.entryPrice,
          exitPrice: trade.exitPrice,
          pnl: trade.pnl,
          openedAt: trade.openedAt,
          closedAt: trade.closedAt ?? eventTsMs,
        }
      : undefined;

  return {
    kind,
    symbol: 'BTCUSD',
    eventTsUtc: utc.toISOString(),
    eventTsIst: ist.toISOString(),
    // Per-side cum PnL including unrealized on the current open position.
    paperLongCumPnl: longPnl.total,
    paperShortCumPnl: shortPnl.total,
    cumPnlTotal: totalCumPnl,
    liveLongCumPnl: liveLong.total,
    liveShortCumPnl: liveShort.total,
    trade: tradePayload,
  };
}

function logPnlSnapshot(snapshot: PnlSnapshot): void {
  logState('PnL snapshot', snapshot);
  // Persist each TRADE_CLOSE snapshot immediately so we never lose trades
  // even if multiple trades happen in the same minute.
  if (snapshot.kind === 'TRADE_CLOSE') {
    writePnlCsvRow(snapshot);
    // Also update the per-minute snapshot, but WITHOUT embedding trade fields,
    // otherwise the minute flush will duplicate the trade row.
    recordPnlMinute({ ...snapshot, trade: undefined });
    return;
  }
  recordPnlMinute(snapshot);
}

// --- Per-minute PnL history (IST), written to CSV for end-of-day analysis ---

let lastPnlMinuteKey: string | null = null;
let lastPnlMinuteSnapshot: PnlSnapshot | null = null;

function ensureLogsDir(): void {
  if (!fs.existsSync('logs')) fs.mkdirSync('logs', { recursive: true });
}

function writeBtcResetCsvRow(params: {
  kind: 'DAILY_RESET' | 'FEED_MODE_SWITCH';
  tsMs: number;
  reason: string;
  feedMode: FeedMode;
  currentPrice: number;
  resetPrice: number;
  marketPrice: number | null;
  marketTickTs: number | null;
}): void {
  ensureLogsDir();

  const istIso = new Date(params.tsMs + 5.5 * 60 * 60 * 1000).toISOString();
  const datePart = istIso.slice(0, 10); // YYYY-MM-DD
  const timePart = istIso.slice(11, 19); // HH:MM:SS

  const filePath = path.join('logs', `btc-reset-${datePart}.csv`);
  const header =
    'timeIst,kind,reason,feedMode,currentPrice,resetPrice,marketPrice,marketTickTs\n';
  if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, header, 'utf8');

  const reason = JSON.stringify(params.reason || '');
  const marketPrice =
    typeof params.marketPrice === 'number' && Number.isFinite(params.marketPrice)
      ? params.marketPrice.toFixed(2)
      : '';
  const marketTickTs =
    typeof params.marketTickTs === 'number' && Number.isFinite(params.marketTickTs)
      ? String(params.marketTickTs)
      : '';

  const line =
    `${datePart} ${timePart},` +
    `${params.kind},` +
    `${reason},` +
    `${params.feedMode},` +
    `${params.currentPrice.toFixed(2)},` +
    `${params.resetPrice.toFixed(2)},` +
    `${marketPrice},` +
    `${marketTickTs}\n`;

  fs.appendFileSync(filePath, line, 'utf8');
}

function writePnlCsvRow(snapshot: PnlSnapshot): void {
  // Ensure logs folder exists (fresh droplet installs, etc.)
  ensureLogsDir();

  const istIso = snapshot.eventTsIst;
  const datePart = istIso.slice(0, 10); // YYYY-MM-DD
  const timePart = istIso.slice(11, 16); // HH:MM
  const minuteKey = `${datePart} ${timePart}`;

  const filePath = path.join('logs', `pnl-${datePart}.csv`);
  const header =
    'timeIst,paperLongCumPnl,paperShortCumPnl,liveLongCumPnl,liveShortCumPnl,tradeSide,tradeEntry,tradeExit,tradePnl\n';

   const trade = snapshot.trade;
   const tradeSide = trade ? trade.side : '';
   const tradeEntry = trade ? trade.entryPrice.toFixed(2) : '';
   const tradeExit = trade ? trade.exitPrice.toFixed(2) : '';
   const tradePnl = trade ? trade.pnl.toFixed(2) : '';

  const line =
    `${minuteKey},` +
    `${snapshot.paperLongCumPnl.toFixed(2)},` +
    `${snapshot.paperShortCumPnl.toFixed(2)},` +
    `${snapshot.liveLongCumPnl.toFixed(2)},` +
    `${snapshot.liveShortCumPnl.toFixed(2)},` +
    `${tradeSide},` +
    `${tradeEntry},` +
    `${tradeExit},` +
    `${tradePnl}\n`;

  if (!fs.existsSync(filePath)) {
    fs.appendFileSync(filePath, header + line);
  } else {
    fs.appendFileSync(filePath, line);
  }
}

function recordPnlMinute(snapshot: PnlSnapshot): void {
  const istIso = snapshot.eventTsIst;
  const datePart = istIso.slice(0, 10);
  const timePart = istIso.slice(11, 16); // HH:MM
  const minuteKey = `${datePart} ${timePart}`;

  if (!lastPnlMinuteKey) {
    lastPnlMinuteKey = minuteKey;
    lastPnlMinuteSnapshot = snapshot;
    return;
  }

  if (minuteKey === lastPnlMinuteKey) {
    // Same minute → overwrite in-memory snapshot; no immediate write.
    lastPnlMinuteSnapshot = snapshot;
    return;
  }

  // Minute changed → flush previous minute once, then start tracking the new minute.
  if (lastPnlMinuteSnapshot) writePnlCsvRow(lastPnlMinuteSnapshot);
  lastPnlMinuteKey = minuteKey;
  lastPnlMinuteSnapshot = snapshot;
}

function flushPnlMinuteSnapshot(): void {
  if (!lastPnlMinuteSnapshot) return;
  writePnlCsvRow(lastPnlMinuteSnapshot);
  lastPnlMinuteKey = null;
  lastPnlMinuteSnapshot = null;
}

function recordMinuteHeartbeat(nowTs: number): void {
  // Keep CSV updated even when no trades close for hours.
  // This should be lightweight (no log spam).
  recordPnlMinute(buildPnlSnapshot('MINUTE', nowTs));
}

let lastBtcHeartbeatTs: number | null = null;

function processBtcTick(nowTs: number, ltp: number): void {
  runDailyResetIfNeeded(nowTs);
  currentPrice = ltp;
  lastBtcTickTs = nowTs;

  const tick = {
    symbolId: 'BTCUSD',
    ltp: currentPrice,
    ts: nowTs,
  };

  applyBtcTrailingStopsBeforeTick(currentPrice);

  onTick(paperLongCtx, tick);
  onTick(paperShortCtx, tick);

  syncBtcTrailingStateAfterTick();

  onLiveTick(liveLongCtx, nowTs);
  onLiveTick(liveShortCtx, nowTs);

  const cumPnlTotal = getTotalCumPnl();

  if (
    forceExitIfCumPnlNonPositive(liveLongCtx, cumPnlTotal, nowTs) ===
    'CLOSE_POSITION'
  ) {
    closeLiveLong(currentPrice);
  }
  if (
    forceExitIfCumPnlNonPositive(liveShortCtx, cumPnlTotal, nowTs) ===
    'CLOSE_POSITION'
  ) {
    closeLiveShort(currentPrice);
  }

  if (paperLongCtx.position.isOpen) {
    const action = tryOpenLiveFromPaperPosition(liveLongCtx, cumPnlTotal, nowTs);
    if (action === 'OPEN_POSITION' && paperLongCtx.position.entryPrice != null) {
      logState('LIVE LONG opening from already-open paper position', {
        paperEntryPrice: paperLongCtx.position.entryPrice,
        liveEntryPrice: currentPrice,
        cumPnlTotal,
        nowTs,
      });
      liveLongCtx.position.entryPrice = currentPrice;
      openLiveLong(currentPrice);
    }
  }

  if (paperShortCtx.position.isOpen) {
    const action = tryOpenLiveFromPaperPosition(liveShortCtx, cumPnlTotal, nowTs);
    if (action === 'OPEN_POSITION' && paperShortCtx.position.entryPrice != null) {
      logState('LIVE SHORT opening from already-open paper position', {
        paperEntryPrice: paperShortCtx.position.entryPrice,
        liveEntryPrice: currentPrice,
        cumPnlTotal,
        nowTs,
      });
      liveShortCtx.position.entryPrice = currentPrice;
      openLiveShort(currentPrice);
    }
  }

  checkForNewTrades();

  // PnL history is per-minute; throttle heartbeats to ~1Hz even if price feed is faster.
  if (lastBtcHeartbeatTs == null || nowTs - lastBtcHeartbeatTs >= 1000) {
    lastBtcHeartbeatTs = nowTs;
    recordMinuteHeartbeat(nowTs);
  }
}

function processBtcMarketTick(nowTs: number, ltp: number): void {
  lastBtcMarketPrice = ltp;
  lastBtcMarketTickTs = nowTs;
  processBtcTick(nowTs, ltp);
}

function resetBtcForFeedModeSwitch(nowTs: number, reason: string): void {
  const resetPrice = lastBtcMarketPrice ?? currentPrice;
  lastBtcResetPrice = resetPrice;
  lastBtcResetTs = nowTs;

  writeBtcResetCsvRow({
    kind: 'FEED_MODE_SWITCH',
    tsMs: nowTs,
    reason,
    feedMode,
    currentPrice,
    resetPrice,
    marketPrice: lastBtcMarketPrice,
    marketTickTs: lastBtcMarketTickTs,
  });

  logState('Resetting BTC state for feed-mode switch', {
    reason,
    nowTs,
    currentPrice,
    resetPrice,
    lastBtcMarketPrice,
    lastBtcMarketTickTs,
    feedMode,
  });

  // Close any open paper positions at the current price so PnL is consistent.
  if (paperLongCtx.position.isOpen && paperLongCtx.position.entryPrice != null) {
    closePosition(paperLongCtx, resetPrice, nowTs);
  }
  if (paperShortCtx.position.isOpen && paperShortCtx.position.entryPrice != null) {
    closePosition(paperShortCtx, resetPrice, nowTs);
  }

  // Close any open live positions and clear live entry prices to avoid price-scale mismatches.
  if (liveLongCtx.position.isOpen) closeLiveLong(resetPrice);
  if (liveShortCtx.position.isOpen) closeLiveShort(resetPrice);

  liveLongCtx.state = LiveState.IDLE;
  liveLongCtx.position.isOpen = false;
  liveLongCtx.position.entryPrice = null;
  liveLongCtx.position.openedAt = null;
  liveLongCtx.lockUntilTs = undefined;

  liveShortCtx.state = LiveState.IDLE;
  liveShortCtx.position.isOpen = false;
  liveShortCtx.position.entryPrice = null;
  liveShortCtx.position.openedAt = null;
  liveShortCtx.lockUntilTs = undefined;

  liveLongEntryPrice = null;
  liveShortEntryPrice = null;
  btcLongTrailHigh = null;
  btcShortTrailLow = null;

  // Record any newly closed paper trades + a heartbeat snapshot for visibility.
  checkForNewTrades();
  recordMinuteHeartbeat(nowTs);
}

function checkForNewTrades(): void {
  // LONG side
  if (paperLongCtx.trades.length > lastLongTradeCount) {
    for (let i = lastLongTradeCount; i < paperLongCtx.trades.length; i += 1) {
      const trade = paperLongCtx.trades[i];
      const eventTs = trade.closedAt ?? Date.now();
      logPnlSnapshot(buildPnlSnapshot('TRADE_CLOSE', eventTs, trade));

      // Practical behavior: when paper closes a position, also close the corresponding live position.
      // This keeps live aligned with paper exits (independent of the cumPnL gate).
      if (liveLongCtx.position.isOpen) {
        liveLongCtx.position.isOpen = false;
        liveLongCtx.position.entryPrice = null;
        liveLongCtx.position.openedAt = null;
        liveLongCtx.state = LiveState.IDLE;
        liveLongCtx.lockUntilTs = undefined;
        closeLiveLong(trade.exitPrice ?? currentPrice);
      }
    }
    lastLongTradeCount = paperLongCtx.trades.length;
  }

  // SHORT side
  if (paperShortCtx.trades.length > lastShortTradeCount) {
    for (let i = lastShortTradeCount; i < paperShortCtx.trades.length; i += 1) {
      const trade = paperShortCtx.trades[i];
      const eventTs = trade.closedAt ?? Date.now();
      logPnlSnapshot(buildPnlSnapshot('TRADE_CLOSE', eventTs, trade));

      if (liveShortCtx.position.isOpen) {
        liveShortCtx.position.isOpen = false;
        liveShortCtx.position.entryPrice = null;
        liveShortCtx.position.openedAt = null;
        liveShortCtx.state = LiveState.IDLE;
        liveShortCtx.lockUntilTs = undefined;
        closeLiveShort(trade.exitPrice ?? currentPrice);
      }
    }
    lastShortTradeCount = paperShortCtx.trades.length;
  }
}

// build view object for UI for each paper FSM
function buildPaperView(ctx: FSMContext) {
  const pnl = getSideLivePnl(ctx);
  return {
    symbolId: ctx.symbolId,
    state: ctx.state,
    position: ctx.position,
    savedBUYLTP: ctx.savedBUYLTP,
    savedSELLLTP: ctx.savedSELLLTP,
    buyEntryTrigger: ctx.buyEntryTrigger,
    sellEntryTrigger: ctx.sellEntryTrigger,
    buyStop: ctx.buyStop,
    sellStop: ctx.sellStop,
    trades: ctx.trades,
    cumPnl: pnl.total,
    realizedCumPnl: pnl.realized,
    unrealizedPnl: pnl.unrealized,
  };
}

// state for /state endpoint
function getStateSnapshot() {
  const liveLong = getLiveLongPnl();
  const liveShort = getLiveShortPnl();

  return {
    serverNowTs: Date.now(),
    feedMode,
    currentPrice,
    lastBtcTickTs,
    lastBtcMarketPrice,
    lastBtcMarketTickTs,
    lastBtcResetPrice,
    lastBtcResetTs,
    autoMode,

    cumPnlTotal: getTotalCumPnl(),

    paperLong: buildPaperView(paperLongCtx),
    paperShort: buildPaperView(paperShortCtx),

    liveLong: {
      state: liveLongCtx.state,
      position: liveLongCtx.position,
      lockUntilTs: liveLongCtx.lockUntilTs ?? null,
      realizedCumPnl: liveLong.realized,
      unrealizedPnl: liveLong.unrealized,
      cumPnl: liveLong.total,
    },

    liveShort: {
      state: liveShortCtx.state,
      position: liveShortCtx.position,
      lockUntilTs: liveShortCtx.lockUntilTs ?? null,
      realizedCumPnl: liveShort.realized,
      unrealizedPnl: liveShort.unrealized,
      cumPnl: liveShort.total,
    },

    liveTradeEvents,
  };
}

// --- Daily reset at 05:30 IST: close positions and restart FSMs ---

function runDailyResetIfNeeded(nowUtcMs: number) {
  // convert to IST by adding 5.5 hours
  const ist = new Date(nowUtcMs + 5.5 * 60 * 60 * 1000);
  const istHour = ist.getHours();
  const istMinute = ist.getMinutes();

  const istDateKey = ist.toISOString().slice(0, 10); // YYYY-MM-DD of IST-shifted time

  if (istHour === 5 && istMinute === 30 && lastDailyResetIstDate !== istDateKey) {
    lastDailyResetIstDate = istDateKey;
    const nowTs = nowUtcMs;

    const resetPrice = lastBtcMarketPrice ?? currentPrice;
    lastBtcResetPrice = resetPrice;
    lastBtcResetTs = nowTs;

    writeBtcResetCsvRow({
      kind: 'DAILY_RESET',
      tsMs: nowTs,
      reason: '05:30_IST',
      feedMode,
      currentPrice,
      resetPrice,
      marketPrice: lastBtcMarketPrice,
      marketTickTs: lastBtcMarketTickTs,
    });

    logState('Daily reset at 05:30 IST starting', {
      istDate: istDateKey,
      istTime: ist.toISOString(),
      currentPrice,
      resetPrice,
      lastBtcMarketPrice,
      lastBtcMarketTickTs,
    });

    // Close any open paper positions at currentPrice
    if (paperLongCtx.position.isOpen && paperLongCtx.position.entryPrice != null) {
      closePosition(paperLongCtx, resetPrice, nowTs);
    }
    if (paperShortCtx.position.isOpen && paperShortCtx.position.entryPrice != null) {
      closePosition(paperShortCtx, resetPrice, nowTs);
    }

    // Close any open live positions and notify Bharath
    if (liveLongCtx.position.isOpen) {
      // Close live LONG → SELL
      closeLiveLong(resetPrice);
    }
    if (liveShortCtx.position.isOpen) {
      // Close live SHORT → BUY
      closeLiveShort(resetPrice);
    }

    // Log final PnL snapshot for the day
    logPnlSnapshot(buildPnlSnapshot('DAILY_RESET', nowTs));
    // Ensure the last minute snapshot is persisted before resetting contexts.
    flushPnlMinuteSnapshot();

    // Recreate fresh FSM contexts for new day
    paperLongCtx = createFSM('BTCUSD');
    paperShortCtx = createFSM('BTCUSD');
    liveLongCtx = createLiveContext('BTCUSD-LONG');
    liveShortCtx = createLiveContext('BTCUSD-SHORT');
    optionsManager.resetAll(nowTs);

    // Reset trade counters for new contexts
    lastLongTradeCount = paperLongCtx.trades.length;
    lastShortTradeCount = paperShortCtx.trades.length;
    liveLongCumPnl = 0;
    liveShortCumPnl = 0;
    liveLongEntryPrice = null;
    liveShortEntryPrice = null;
    btcLongTrailHigh = null;
    btcShortTrailLow = null;

    logState('Daily reset at 05:30 IST completed', {
      istDate: istDateKey,
      istTime: ist.toISOString(),
    });
  }
}

// --- Delta live feed (primary mode, WebSocket) ---
startDeltaFeed(
  paperLongCtx,
  paperShortCtx,
  liveLongCtx,
  liveShortCtx,
  (p) => {
    currentPrice = p;
  },
  (p, nowTs) => processBtcMarketTick(nowTs, p),
  () => feedMode === 'DELTA',
);

// --- SIM feed (manual / auto) ---

// auto-sim loop: only active when feedMode === 'SIM'
setInterval(() => {
  if (feedMode !== 'SIM') return;
  if (autoMode === 'PAUSE') return;

  if (autoMode === 'UP') {
    currentPrice += TICK_STEP;
  } else if (autoMode === 'DOWN') {
    currentPrice -= TICK_STEP;
  } else {
    const dir = Math.random() < 0.5 ? -1 : 1;
    currentPrice += dir * TICK_STEP;
  }

  const now = Date.now();
  processBtcTick(now, currentPrice);
}, SIM_INTERVAL_MS);

// --- Zerodha tick ingest (options) ---
// Zerodha can be integrated via a separate process that POSTs token+ltp here.
app.post('/zerodha/tick', (req, res) => {
  const body = req.body as { token?: number; ltp?: number; ts?: number };
  const token = body.token;
  const ltp = body.ltp;
  const ts = typeof body.ts === 'number' ? body.ts : Date.now();

  if (typeof token !== 'number' || !Number.isFinite(token)) {
    return res.status(400).json({ error: 'token must be a number' });
  }
  if (typeof ltp !== 'number' || !Number.isFinite(ltp)) {
    return res.status(400).json({ error: 'ltp must be a number' });
  }

  const resolved = resolveZerodhaTick({ token, ltp, ts });
  if (!resolved) {
    captureZerodhaTick({ tsMs: ts, token, symbolId: null, ltp });
    return res.status(404).json({ error: 'unknown token', token });
  }

  optionsManager.handleTickBySymbol(resolved.symbolId, resolved.ltp, resolved.ts);
  captureZerodhaTick({ tsMs: resolved.ts, token, symbolId: resolved.symbolId, ltp: resolved.ltp });

  return res.json({
    ok: true,
    symbolId: resolved.symbolId,
    ltp: resolved.ltp,
    ts,
  });
});

// --- Wire paper → live hooks ---

// when paper LONG opens, notify liveLong
registerPaperLongOpen((paperCtx, nowTs, windowEndTs, entryLtp) => {
  // sir's cum logic = total over both sides
  const cumPnlTotal = getTotalCumPnl();

  const action = onPaperEntryOpportunity(
    liveLongCtx,
    cumPnlTotal,
    nowTs,
    windowEndTs,
  );

  if (action === 'OPEN_POSITION') {
    liveLongCtx.position.entryPrice = entryLtp;
    console.log('LIVE LONG: Would OPEN LONG at', entryLtp);
    // Send live ENTRY to Bharath
    openLiveLong(entryLtp);
  } else if (action === 'CLOSE_POSITION') {
    // Already handled by forceExitIfCumPnlNonPositive
    console.log('LIVE LONG: CLOSE_POSITION from paper hook (already exited)');
  }
});

// when paper SHORT opens, notify liveShort
registerPaperShortOpen((paperCtx, nowTs, windowEndTs, entryLtp) => {
  const cumPnlTotal = getTotalCumPnl();

  const action = onPaperEntryOpportunity(
    liveShortCtx,
    cumPnlTotal,
    nowTs,
    windowEndTs,
  );

  if (action === 'OPEN_POSITION') {
    liveShortCtx.position.entryPrice = entryLtp;
    console.log('LIVE SHORT: Would OPEN SHORT at', entryLtp);
    // Send live OPEN SHORT → SELL to Bharath
    openLiveShort(entryLtp);
  } else if (action === 'CLOSE_POSITION') {
    // Already handled by forceExitIfCumPnlNonPositive
    console.log('LIVE SHORT: CLOSE_POSITION from paper hook (already exited)');
  }
});

// --- Routes ---

// POST /signal  { side: "BUY" | "SELL" }
app.post('/signal', (req, res) => {
  const { side } = req.body as { side?: 'BUY' | 'SELL' };

  if (side !== 'BUY' && side !== 'SELL') {
    return res.status(400).json({ error: 'side must be BUY or SELL' });
  }

  const now = Date.now();

  if (side === 'BUY') {
    onSignal(paperLongCtx, {
      symbolId: 'BTCUSD',
      side,
      ts: now,
    });

    pushRecentSignal({
      tsUtc: new Date(now).toISOString(),
      tsIst: toIstIso(now),
      source: 'Manual',
      httpPath: '/signal',
      parsedAction: 'ENTRY',
      symbol: 'BTCUSD',
      routedTo: 'PAPER_LONG_BUY',
      note: 'Manual /signal BUY',
    });
  } else {
    onSignal(paperShortCtx, {
      symbolId: 'BTCUSD',
      side,
      ts: now,
    });

    pushRecentSignal({
      tsUtc: new Date(now).toISOString(),
      tsIst: toIstIso(now),
      source: 'Manual',
      httpPath: '/signal',
      parsedAction: 'EXIT',
      symbol: 'BTCUSD',
      routedTo: 'PAPER_SHORT_SELL',
      note: 'Manual /signal SELL',
    });
  }

  return res.json({
    message: 'Signal processed',
    state: getStateSnapshot(),
  });
});

// POST /feed-mode  { mode: "DELTA" | "SIM" }
app.post('/feed-mode', (req, res) => {
  const { mode } = req.body as { mode?: FeedMode };

  if (mode !== 'DELTA' && mode !== 'SIM') {
    return res.status(400).json({
      error: 'mode must be "DELTA" or "SIM"',
    });
  }

  // Prevent mixing SIM prices (e.g. 100/228) with DELTA prices (~86k) while positions are open.
  if (mode !== feedMode) {
    resetBtcForFeedModeSwitch(Date.now(), `feedMode ${feedMode} -> ${mode}`);
  }
  feedMode = mode;
  if (feedMode !== 'SIM') autoMode = 'PAUSE';

  return res.json({
    message: 'Feed mode updated',
    feedMode,
    state: getStateSnapshot(),
  });
});

// POST /webhook  { message: string }
// Example payloads:
//  { "message": "Accepted Entry + priorRisePct= 0.00 | stopPx=100 | sym=BTCUSD" }
//  { "message": "Accepted Exit+ priorRisePct= 0.00 | stopPx=100 | sym=BTCUSD" }
app.post('/webhook', (req, res) => {
  const body = req.body as unknown;
  let message: string | undefined;
  const rawBodyText =
    typeof body === 'string'
      ? body
      : Buffer.isBuffer(body)
        ? body.toString('utf8')
        : body && typeof body === 'object'
          ? JSON.stringify(body)
          : String(body ?? '');

  if (typeof body === 'string') {
    const trimmed = body.trim();
    // If the text body is actually JSON, extract a `message` field when present.
    if (trimmed.startsWith('{') || trimmed.startsWith('[') || trimmed.startsWith('"')) {
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (typeof parsed === 'string') {
          message = parsed;
        } else if (parsed && typeof parsed === 'object') {
          const parsedMessage = (parsed as { message?: unknown }).message;
          if (typeof parsedMessage === 'string') message = parsedMessage;
          else if (parsedMessage != null) message = JSON.stringify(parsedMessage);
          else message = JSON.stringify(parsed);
        } else if (parsed != null) {
          message = String(parsed);
        }
      } catch {
        // Not JSON; treat as plain text.
        message = body;
      }
    } else {
      message = body;
    }
  } else if (Buffer.isBuffer(body)) {
    message = body.toString('utf8');
  } else if (body && typeof body === 'object') {
    const maybeMessage = (body as { message?: unknown }).message;
    if (typeof maybeMessage === 'string') message = maybeMessage;
    else if (maybeMessage != null) message = JSON.stringify(maybeMessage);
  }

  if (typeof message !== 'string') {
    return res.status(400).json({ error: 'message must be a string' });
  }

  // Basic parsing
  const isEntry = message.includes('Accepted Entry');
  const isExit = message.includes('Accepted Exit');
  const symMatch = message.match(/sym=([A-Z0-9]+)/);
  const stopMatch = message.match(/stopPx=([\d.]+)/);

  const rawSymbol = symMatch?.[1] ?? 'BTCUSD';
  const symbol =
    rawSymbol === 'BTCUSDT'
      ? 'BTCUSD'
      : rawSymbol;
  const stopPx = stopMatch ? Number(stopMatch[1]) : undefined;

  if (symbol !== 'BTCUSD') {
    const instrument = getInstrumentByTradingViewSymbol(symbol);
    if (!instrument) {
      const nowIgnored = Date.now();
      captureWebhookSignal({
        tsMs: nowIgnored,
        contentType: String(req.headers['content-type'] || ''),
        rawBodyText,
        message,
        action: isEntry ? 'ENTRY' : isExit ? 'EXIT' : 'UNKNOWN',
        rawSymbol,
        mappedSymbol: symbol,
        stopPx: typeof stopPx === 'number' ? stopPx : null,
        routedTo: 'IGNORED',
      });
      pushRecentSignal({
        tsUtc: new Date(nowIgnored).toISOString(),
        tsIst: toIstIso(nowIgnored),
        source: 'TradingView',
        httpPath: '/webhook',
        rawMessage: message,
        parsedAction: isEntry ? 'ENTRY' : isExit ? 'EXIT' : null,
        stopPx: stopPx ?? null,
        rawSymbol,
        symbol,
        routedTo: 'IGNORED',
        note: 'Ignored symbol',
      });
      return res.json({ message: 'ignored symbol', symbol: rawSymbol });
    }

    const nowOpt = Date.now();
    const action = isEntry ? 'ENTRY' : isExit ? 'EXIT' : null;
    if (!action) {
      captureWebhookSignal({
        tsMs: nowOpt,
        contentType: String(req.headers['content-type'] || ''),
        rawBodyText,
        message,
        action: 'UNKNOWN',
        rawSymbol,
        mappedSymbol: instrument.tradingview,
        stopPx: typeof stopPx === 'number' ? stopPx : null,
        routedTo: 'OPTIONS',
      });
      pushRecentSignal({
        tsUtc: new Date(nowOpt).toISOString(),
        tsIst: toIstIso(nowOpt),
        source: 'TradingView',
        httpPath: '/webhook',
        rawMessage: message,
        parsedAction: null,
        stopPx: stopPx ?? null,
        rawSymbol,
        symbol: instrument.tradingview,
        routedTo: 'OPTIONS',
        note: 'Options webhook received but no condition matched',
      });
      return res.json({ message: 'no condition matched', symbol });
    }

    const result = optionsManager.handleTvSignal(
      instrument.tradingview,
      action,
      nowOpt,
    );

    captureWebhookSignal({
      tsMs: nowOpt,
      contentType: String(req.headers['content-type'] || ''),
      rawBodyText,
      message,
      action,
      rawSymbol,
      mappedSymbol: instrument.tradingview,
      stopPx: typeof stopPx === 'number' ? stopPx : null,
      routedTo: 'OPTIONS',
    });
    pushRecentSignal({
      tsUtc: new Date(nowOpt).toISOString(),
      tsIst: toIstIso(nowOpt),
      source: 'TradingView',
      httpPath: '/webhook',
      rawMessage: message,
      parsedAction: action,
      stopPx: stopPx ?? null,
      rawSymbol,
      symbol: instrument.tradingview,
      routedTo: 'OPTIONS',
      note: `Options routed (${result.kind})`,
    });

    return res.json({
      message: 'Options webhook processed',
      symbol: instrument.tradingview,
      stopPx,
      result,
    });
  }

  const now = Date.now();

  if (isEntry) {
    // Treat BTCUSD "Accepted Entry" as BUY signal → paper LONG FSM
    onSignal(paperLongCtx, {
      symbolId: 'BTCUSD',
      side: 'BUY',
      ts: now,
    });

    captureWebhookSignal({
      tsMs: now,
      contentType: String(req.headers['content-type'] || ''),
      rawBodyText,
      message,
      action: 'ENTRY',
      rawSymbol,
      mappedSymbol: 'BTCUSD',
      stopPx: typeof stopPx === 'number' ? stopPx : null,
      routedTo: 'PAPER_LONG_BUY',
    });
    pushRecentSignal({
      tsUtc: new Date(now).toISOString(),
      tsIst: toIstIso(now),
      source: 'TradingView',
      httpPath: '/webhook',
      rawMessage: message,
      parsedAction: 'ENTRY',
      stopPx: stopPx ?? null,
      rawSymbol,
      symbol: 'BTCUSD',
      routedTo: 'PAPER_LONG_BUY',
      note: 'Accepted Entry routed to paper LONG BUY',
    });

    return res.json({
      message: 'Entry processed as BUY for BTCUSD (paper LONG)',
      stopPx,
      state: getStateSnapshot(),
    });
  }

  if (isExit) {
    // Treat BTCUSD "Accepted Exit" as SELL signal → paper SHORT FSM
    onSignal(paperShortCtx, {
      symbolId: 'BTCUSD',
      side: 'SELL',
      ts: now,
    });

    captureWebhookSignal({
      tsMs: now,
      contentType: String(req.headers['content-type'] || ''),
      rawBodyText,
      message,
      action: 'EXIT',
      rawSymbol,
      mappedSymbol: 'BTCUSD',
      stopPx: typeof stopPx === 'number' ? stopPx : null,
      routedTo: 'PAPER_SHORT_SELL',
    });
    pushRecentSignal({
      tsUtc: new Date(now).toISOString(),
      tsIst: toIstIso(now),
      source: 'TradingView',
      httpPath: '/webhook',
      rawMessage: message,
      parsedAction: 'EXIT',
      stopPx: stopPx ?? null,
      rawSymbol,
      symbol: 'BTCUSD',
      routedTo: 'PAPER_SHORT_SELL',
      note: 'Accepted Exit routed to paper SHORT SELL',
    });

    return res.json({
      message: 'Exit processed as SELL for BTCUSD (paper SHORT)',
      stopPx,
      state: getStateSnapshot(),
    });
  }

  pushRecentSignal({
    tsUtc: new Date(now).toISOString(),
    tsIst: toIstIso(now),
    source: 'TradingView',
    httpPath: '/webhook',
    rawMessage: message,
    parsedAction: null,
    stopPx: stopPx ?? null,
    rawSymbol,
    symbol: 'BTCUSD',
    routedTo: null,
    note: 'No condition matched',
  });

  captureWebhookSignal({
    tsMs: now,
    contentType: String(req.headers['content-type'] || ''),
    rawBodyText,
    message,
    action: 'UNKNOWN',
    rawSymbol,
    mappedSymbol: 'BTCUSD',
    stopPx: typeof stopPx === 'number' ? stopPx : null,
    routedTo: null,
  });
  return res.json({
    message: 'Webhook message received but no condition matched',
    state: getStateSnapshot(),
  });
});


// POST /tick  { ltp: number }  (optional manual tick, mainly for SIM mode)
app.post('/tick', (req, res) => {
  if (feedMode !== 'SIM') {
    return res.status(400).json({
      error: 'tick_only_allowed_in_sim_mode',
      message: 'Manual /tick is only allowed when feedMode=SIM. Use POST /feed-mode first.',
      feedMode,
    });
  }

  const { ltp } = req.body as { ltp?: number };

  if (typeof ltp !== 'number' || Number.isNaN(ltp)) {
    return res.status(400).json({ error: 'ltp must be a number' });
  }

  currentPrice = ltp;
  const now = Date.now();
  processBtcTick(now, currentPrice);

  return res.json({
    message: 'Tick processed',
    state: getStateSnapshot(),
  });
});

// POST /auto  { mode: "PAUSE" | "UP" | "DOWN" | "RANDOM", ltp?: number }
app.post('/auto', (req, res) => {
  const body = req.body as { mode?: AutoMode; ltp?: number };
  const { mode, ltp } = body;

  if (!mode || !['PAUSE', 'UP', 'DOWN', 'RANDOM'].includes(mode)) {
    return res.status(400).json({
      error: 'mode must be one of PAUSE, UP, DOWN, RANDOM',
    });
  }

  // Only allow manual price set in SIM mode; in DELTA mode, currentPrice comes from Delta feed.
  if (feedMode === 'SIM' && typeof ltp === 'number' && !Number.isNaN(ltp)) {
    currentPrice = ltp;
  }

  autoMode = mode;

  return res.json({
    message: 'Auto mode updated',
    autoMode,
    currentPrice,
    state: getStateSnapshot(),
  });
});

// GET /state
app.get('/state', (_req, res) => {
  res.json({
    ...getStateSnapshot(),
    options: optionsManager.getSnapshots(),
  });
});

// GET /logs  → recent FSM logs for UI
app.get('/logs', (_req, res) => {
  res.json({ logs: getRecentLogs() });
});

// GET /recent-signals  → recent incoming TradingView/manual signals
app.get('/recent-signals', (_req, res) => {
  res.json({
    count: recentSignals.length,
    rows: recentSignals,
  });
});

// GET /options/instruments → list configured Indian option instruments
app.get('/options/instruments', (_req, res) => {
  res.json({ instruments: INSTRUMENTS_DATA });
});

// GET /options/state → current paper/live PnL + state per instrument
app.get('/options/state', (_req, res) => {
  res.json({ rows: optionsManager.getSnapshots() });
});

// --- Options: live execution toggle (for Zerodha executor integration) ---
// Default OFF; enable only when zerodha-exec is running and configured.
app.get('/options/execution', (_req, res) => {
  res.json(getOptionsExecutionState());
});

app.post('/options/execution', (req, res) => {
  const body = req.body as { enabled?: unknown; token?: unknown };
  const enabled = body.enabled === true;

  // Require a control token if configured.
  const expected = (process.env.OPTIONS_EXEC_CONTROL_TOKEN || '').trim();
  if (expected) {
    const provided =
      (typeof body.token === 'string' ? body.token : '') ||
      String(req.headers['x-exec-control-token'] || '');
    if (String(provided || '').trim() !== expected) {
      return res.status(403).json({ error: 'forbidden' });
    }
  }

  setOptionsExecutionEnabled(enabled);
  logState('Options execution toggled', { enabled });
  return res.json({ ok: true, enabled });
});

// GET /zerodha/callback
// Zerodha redirects here after login, with request_token in the query string.
// This endpoint can generate an access_token automatically, write it to the env file,
// and restart the zerodha-ticks PM2 process.
app.get('/zerodha/callback', async (req, res) => {
  const requestToken = String((req.query as any).request_token || '');
  const callbackToken = process.env.ZERODHA_CALLBACK_TOKEN;
  const providedToken = String((req.query as any).token || '');

  if (callbackToken && providedToken !== callbackToken) {
    return res.status(403).send('Forbidden');
  }

  if (!requestToken) {
    return res.status(400).send('Missing request_token');
  }

  const apiKey = process.env.KITE_API_KEY;
  const apiSecret = process.env.KITE_API_SECRET;
  if (!apiKey || !apiSecret) {
    return res
      .status(500)
      .send('Server missing KITE_API_KEY / KITE_API_SECRET env vars');
  }

  const envPath =
    process.env.ZERODHA_ENV_PATH ?? path.resolve(process.cwd(), '.env.zerodha');

  try {
    const kc = new KiteConnect({ api_key: apiKey } as any);
    const response = await kc.generateSession(requestToken, apiSecret);
    const accessToken = String((response as any).access_token || '');
    if (!accessToken) throw new Error('generateSession returned no access_token');

    writeZerodhaEnv({
      envPath,
      apiKey,
      apiSecret,
      accessToken,
    });

    // Restart zerodha ticks process so it picks up the new access token.
    const pm2Name = process.env.ZERODHA_PM2_NAME ?? 'zerodha-ticks';
    const doRestart = process.env.ZERODHA_PM2_RESTART !== '0';

    let restartMsg = 'skipped';
    if (doRestart) {
      try {
        execSync(`pm2 restart ${pm2Name}`, { stdio: 'ignore' });
        restartMsg = `restarted ${pm2Name}`;
      } catch (e) {
        restartMsg = `restart failed: ${String(e)}`;
      }
    }

    const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>Zerodha Session</title></head>
<body style="font-family: Arial, sans-serif; margin: 20px;">
  <h2>Zerodha session updated</h2>
  <p><b>Env path:</b> <code>${envPath}</code></p>
  <p><b>PM2:</b> ${restartMsg}</p>
  <p style="font-size: 12px; color: #555;">
    request_token received and access_token written. You can close this tab.
  </p>
</body></html>`;
    return res.status(200).send(html);
  } catch (e) {
    return res.status(500).send(`Failed to generate session: ${String(e)}`);
  }
});

// GET /pnl  → expose current cum PnL that controls live gating
app.get('/pnl', (_req, res) => {
  const now = Date.now();
  const snapshot = buildPnlSnapshot('DAILY_RESET', now); // kind label not important here

  res.json({
    paperLongCumPnl: snapshot.paperLongCumPnl,
    paperShortCumPnl: snapshot.paperShortCumPnl,
    liveLongCumPnl: snapshot.liveLongCumPnl,
    liveShortCumPnl: snapshot.liveShortCumPnl,
  });
});

// GET /pnl-history?date=YYYY-MM-DD  → per-minute PnL + trades for a given day
app.get('/pnl-history', (req, res) => {
  const { date } = req.query as { date?: string };

  if (!date) {
    return res
      .status(400)
      .json({ error: 'date query param is required as YYYY-MM-DD' });
  }

  // very light validation
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res
      .status(400)
      .json({ error: 'date must be in format YYYY-MM-DD' });
  }

  const rows = loadPnlHistory(date);

  return res.json({
    date,
    rows,
  });
});

// GET /options/pnl-history?symbol=<TradingViewSymbol>&date=YYYY-MM-DD
// Returns per-minute rows + trade-close rows for a single options instrument.
app.get('/options/pnl-history', (req, res) => {
  const { date, symbol } = req.query as { date?: string; symbol?: string };

  if (!symbol) {
    return res
      .status(400)
      .json({ error: 'symbol query param is required (TradingView symbol)' });
  }
  if (!date) {
    return res
      .status(400)
      .json({ error: 'date query param is required as YYYY-MM-DD' });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res
      .status(400)
      .json({ error: 'date must be in format YYYY-MM-DD' });
  }

  const rows = loadOptionsHistory({ tradingview: symbol, dateKey: date });
  return res.json({ symbol, date, rows });
});

// --- Global error handler (keeps body-parser JSON errors from spamming PM2 logs) ---
app.use(((err, req, res, next) => {
  // Express/Body-parser invalid JSON typically comes through as SyntaxError with type 'entity.parse.failed'
  const isBadJson =
    err &&
    (err.type === 'entity.parse.failed' ||
      (err instanceof SyntaxError && typeof err.message === 'string' && err.message.includes('JSON')));

  if (!isBadJson) return next(err);

  // Best-effort visibility: log what endpoint/content-type caused it.
  logState('Invalid JSON body rejected', {
    method: req.method,
    path: req.path,
    contentType: req.headers['content-type'] || null,
    ip:
      (req.headers['x-forwarded-for'] as string | undefined) ||
      req.socket.remoteAddress ||
      null,
  });

  return res.status(400).json({ error: 'invalid_json_body' });
}) as express.ErrorRequestHandler);

// Start server
const PORT = 3000;
app.listen(PORT, () => {
  console.log(`FSM demo server running at http://localhost:${PORT}`);
});
