import { createFSM } from './fsmInit';
import { onSignal, onTick } from './fsmEngine';
import { FSMContext, FSMState } from './fsmStates';
import { getWindowRemaining, startWindow } from './fsmWindow';
import { closePosition } from './fsmProfitWindow';
import {
  createLiveContext,
  forceExitIfCumPnlNonPositive,
  onLiveTick,
  onPaperEntryOpportunity,
  tryOpenLiveFromPaperPosition,
} from './liveEngine';
import { LiveContext } from './liveStates';
import { round2, calcCumPnl } from './pnl';
import { InstrumentInfo } from './instruments';
import { logState } from './logger';
import fs from 'fs';
import path from 'path';

export type TvAction = 'ENTRY' | 'EXIT';

export interface OptionsRuntimeSnapshot {
  tradingview: string;
  token: number;
  lot: number;
  lastPrice: number | null;

  paper: {
    state: FSMState;
    position: FSMContext['position'];
    triggers: {
      savedBUYLTP?: number;
      buyEntryTrigger?: number;
      buyStop?: number;
      windowStartTs?: number;
      windowDurationMs?: number;
      waitSourceState?: FSMState;
    };
    realizedCumPnl: number;
    unrealizedPnl: number;
    cumPnl: number;
    tradesCount: number;
    recentTrades: FSMContext['trades'];
  };

  live: {
    state: LiveContext['state'];
    position: LiveContext['position'];
    lockUntilTs: number | null;
    realizedCumPnl: number;
    unrealizedPnl: number;
    cumPnl: number;
    recentTrades: Array<{
      tsIst: string;
      tsUtc: string;
      action: 'OPEN' | 'CLOSE';
      entryPrice: number | null;
      exitPrice: number | null;
      tradePnl: number | null;
      cumPnlAfter: number;
    }>;
  };
}

interface OptionsRuntime {
  instrument: InstrumentInfo;
  paperCtx: FSMContext;
  liveCtx: LiveContext;

  lastPrice: number | null;
  lastPaperWasOpen: boolean;
  lastTradeCount: number;

  liveRealizedCumPnl: number;
  liveEntryPrice: number | null;
  liveTradeEvents: OptionsRuntimeSnapshot['live']['recentTrades'];

  pendingExit: boolean;
  pendingExitRequestedAt: number | null;
  pendingReentryAfterExit: boolean;

  lastMinuteKey: string | null;
  lastMinuteSnapshot: {
    tsMs: number;
    paper: ReturnType<typeof getPaperPnl>;
    live: ReturnType<typeof getLivePnl>;
  } | null;
}

function getPaperPnl(ctx: FSMContext, currentPrice: number | null) {
  const realized = calcCumPnl(ctx.trades);
  let unrealized = 0;
  if (
    currentPrice != null &&
    ctx.position.isOpen &&
    ctx.position.entryPrice != null &&
    ctx.position.side === 'BUY'
  ) {
    unrealized = currentPrice - ctx.position.entryPrice;
  }
  const unrealizedRounded = round2(unrealized);
  return {
    realized,
    unrealized: unrealizedRounded,
    total: round2(realized + unrealizedRounded),
  };
}

function getLivePnl(runtime: OptionsRuntime, currentPrice: number | null) {
  const realized = runtime.liveRealizedCumPnl;
  let unrealized = 0;
  if (currentPrice != null && runtime.liveEntryPrice != null) {
    unrealized = currentPrice - runtime.liveEntryPrice;
  }
  const unrealizedRounded = round2(unrealized);
  return {
    realized,
    unrealized: unrealizedRounded,
    total: round2(realized + unrealizedRounded),
  };
}

function openLive(runtime: OptionsRuntime, entryPrice: number, nowTs: number) {
  runtime.liveEntryPrice = entryPrice;
  runtime.liveCtx.position.entryPrice = entryPrice;
  runtime.liveCtx.position.openedAt = nowTs;

  runtime.liveTradeEvents.push({
    tsUtc: new Date(nowTs).toISOString(),
    tsIst: minuteKeyIst(nowTs).minuteKey,
    action: 'OPEN',
    entryPrice,
    exitPrice: null,
    tradePnl: null,
    cumPnlAfter: runtime.liveRealizedCumPnl,
  });
  if (runtime.liveTradeEvents.length > 50) runtime.liveTradeEvents.shift();
}

function closeLive(runtime: OptionsRuntime, exitPrice: number, nowTs: number) {
  const entry = runtime.liveEntryPrice;
  const openedAt = runtime.liveCtx.position.openedAt ?? nowTs;
  let pnl: number | null = null;
  if (runtime.liveEntryPrice != null) {
    pnl = round2(exitPrice - runtime.liveEntryPrice);
    runtime.liveRealizedCumPnl = round2(runtime.liveRealizedCumPnl + pnl);
  }
  runtime.liveEntryPrice = null;
  runtime.liveCtx.position.entryPrice = null;
  runtime.liveCtx.position.openedAt = null;

  runtime.liveTradeEvents.push({
    tsUtc: new Date(nowTs).toISOString(),
    tsIst: minuteKeyIst(nowTs).minuteKey,
    action: 'CLOSE',
    entryPrice: entry,
    exitPrice,
    tradePnl: pnl,
    cumPnlAfter: runtime.liveRealizedCumPnl,
  });
  if (runtime.liveTradeEvents.length > 50) runtime.liveTradeEvents.shift();

  // Persist live trade close so UI can show full-day history even after restarts.
  if (entry != null && pnl != null) {
    writeOptionsCsvRow({
      symbolId: runtime.instrument.tradingview,
      tsMs: nowTs,
      paper: getPaperPnl(runtime.paperCtx, runtime.lastPrice),
      live: getLivePnl(runtime, runtime.lastPrice),
      liveTrade: {
        openedAt,
        entryPrice: entry,
        exitPrice,
        pnl,
        cumPnlAfter: runtime.liveRealizedCumPnl,
      },
    });
  }
}

function closePaperAndWaitWindow(
  ctx: FSMContext,
  currentPrice: number,
  nowTs: number,
): void {
  // Close at current price
  closePosition(ctx, currentPrice, nowTs);

  // If we are in a timed window, go to WAIT_WINDOW for remaining time.
  // Otherwise go to WAIT_FOR_SIGNAL (safe default).
  const remaining = getWindowRemaining(ctx, nowTs);
  if (remaining == null) {
    ctx.state = FSMState.WAIT_FOR_SIGNAL;
    ctx.windowStartTs = undefined;
    ctx.windowDurationMs = undefined;
    ctx.waitSourceState = undefined;
    return;
  }

  ctx.waitSourceState = ctx.state;
  startWindow(ctx, nowTs, remaining);
  ctx.state = FSMState.WAIT_WINDOW;

  logState('Option EXIT -> WAIT_WINDOW', {
    symbolId: ctx.symbolId,
    remainingMs: remaining,
  });
}

function closePaperAndReenterNow(params: {
  ctx: FSMContext;
  symbolId: string;
  currentPrice: number;
  nowTs: number;
}): void {
  // Close the current paper position at currentPrice
  closePosition(params.ctx, params.currentPrice, params.nowTs);

  // Force a clean "signal-accepted" state and immediately generate a BUY signal
  // using the same current tick price as the first post-signal tick.
  params.ctx.state = FSMState.WAIT_FOR_SIGNAL;
  params.ctx.windowStartTs = undefined;
  params.ctx.windowDurationMs = undefined;
  params.ctx.waitSourceState = undefined;

  onSignal(params.ctx, { symbolId: params.symbolId, side: 'BUY', ts: params.nowTs });
  onTick(params.ctx, { symbolId: params.symbolId, ltp: params.currentPrice, ts: params.nowTs });
}

function ensureLogsDir(): void {
  if (!fs.existsSync('logs')) fs.mkdirSync('logs', { recursive: true });
}

function safeFilePart(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '_');
}

function minuteKeyIst(tsMs: number): { datePart: string; minuteKey: string } {
  const ist = new Date(tsMs + 5.5 * 60 * 60 * 1000);
  const iso = ist.toISOString(); // YYYY-MM-DDTHH:mm:ss.sssZ
  const datePart = iso.slice(0, 10);
  const timePart = iso.slice(11, 16);
  return { datePart, minuteKey: `${datePart} ${timePart}` };
}

function writeOptionsCsvRow(params: {
  symbolId: string;
  tsMs: number;
  paper: ReturnType<typeof getPaperPnl>;
  live: ReturnType<typeof getLivePnl>;
  paperTrade?: {
    side: 'BUY' | 'SELL';
    openedAt: number;
    entryPrice: number;
    exitPrice: number;
    pnl: number;
  };
  liveTrade?: {
    openedAt: number;
    entryPrice: number;
    exitPrice: number;
    pnl: number;
    cumPnlAfter: number;
  };
}): void {
  ensureLogsDir();

  const { datePart, minuteKey } = minuteKeyIst(params.tsMs);
  const safeSym = safeFilePart(params.symbolId);
  const filePath = path.join('logs', `options-${safeSym}-${datePart}.csv`);

  const header =
    'timeIst,paperCumPnl,paperRealized,paperUnrealized,liveCumPnl,liveRealized,liveUnrealized,tradeSide,tradeOpenedAtMs,tradeEntry,tradeExit,tradePnl,liveTradeOpenedAtMs,liveTradeEntry,liveTradeExit,liveTradePnl,liveTradeCumAfter\n';

  if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, header, 'utf8');

  const paperTrade = params.paperTrade;
  const tradeSide = paperTrade ? paperTrade.side : '';
  const tradeOpenedAtMs = paperTrade ? String(paperTrade.openedAt) : '';
  const tradeEntry = paperTrade ? paperTrade.entryPrice.toFixed(2) : '';
  const tradeExit = paperTrade ? paperTrade.exitPrice.toFixed(2) : '';
  const tradePnl = paperTrade ? paperTrade.pnl.toFixed(2) : '';

  const liveTrade = params.liveTrade;
  const liveTradeOpenedAtMs = liveTrade ? String(liveTrade.openedAt) : '';
  const liveTradeEntry = liveTrade ? liveTrade.entryPrice.toFixed(2) : '';
  const liveTradeExit = liveTrade ? liveTrade.exitPrice.toFixed(2) : '';
  const liveTradePnl = liveTrade ? liveTrade.pnl.toFixed(2) : '';
  const liveTradeCumAfter = liveTrade ? liveTrade.cumPnlAfter.toFixed(2) : '';

  const line =
    `${minuteKey},` +
    `${params.paper.total.toFixed(2)},` +
    `${params.paper.realized.toFixed(2)},` +
    `${params.paper.unrealized.toFixed(2)},` +
    `${params.live.total.toFixed(2)},` +
    `${params.live.realized.toFixed(2)},` +
    `${params.live.unrealized.toFixed(2)},` +
    `${tradeSide},${tradeOpenedAtMs},${tradeEntry},${tradeExit},${tradePnl},` +
    `${liveTradeOpenedAtMs},${liveTradeEntry},${liveTradeExit},${liveTradePnl},${liveTradeCumAfter}\n`;

  fs.appendFileSync(filePath, line, 'utf8');
}

function maybeFlushMinute(runtime: OptionsRuntime, nowTs: number): void {
  const { minuteKey } = minuteKeyIst(nowTs);
  if (runtime.lastMinuteKey == null) {
    runtime.lastMinuteKey = minuteKey;
    return;
  }
  if (minuteKey === runtime.lastMinuteKey) return;

  if (runtime.lastMinuteSnapshot) {
    writeOptionsCsvRow({
      symbolId: runtime.instrument.tradingview,
      tsMs: runtime.lastMinuteSnapshot.tsMs,
      paper: runtime.lastMinuteSnapshot.paper,
      live: runtime.lastMinuteSnapshot.live,
    });
  }
  runtime.lastMinuteKey = minuteKey;
  runtime.lastMinuteSnapshot = null;
}

export class OptionsRuntimeManager {
  private runtimes = new Map<string, OptionsRuntime>();

  constructor(private instruments: InstrumentInfo[]) {}

  private getOrCreate(symbolId: string): OptionsRuntime {
    const existing = this.runtimes.get(symbolId);
    if (existing) return existing;

    const instrument = this.instruments.find((i) => i.tradingview === symbolId);
    if (!instrument) {
      throw new Error(`Unknown instrument: ${symbolId}`);
    }

    const paperCtx = createFSM(symbolId);
    const liveCtx = createLiveContext(`${symbolId}-LIVE`);

    const runtime: OptionsRuntime = {
      instrument,
      paperCtx,
      liveCtx,
      lastPrice: null,
      lastPaperWasOpen: false,
      lastTradeCount: 0,
      liveRealizedCumPnl: 0,
      liveEntryPrice: null,
      liveTradeEvents: [],
      pendingExit: false,
      pendingExitRequestedAt: null,
      pendingReentryAfterExit: false,
      lastMinuteKey: null,
      lastMinuteSnapshot: null,
    };

    this.runtimes.set(symbolId, runtime);
    return runtime;
  }

  handleTvSignal(symbolId: string, action: TvAction, nowTs: number) {
    const runtime = this.getOrCreate(symbolId);

    // Rule:
    // - BUY/ENTRY while open => ignore
    // - EXIT while open => sell/close immediately
    // - EXIT while not open => treat as BUY/ENTRY
    // - ENTRY while not open => BUY/ENTRY
    const isOpen = runtime.paperCtx.position.isOpen;
    const ltp = runtime.lastPrice;

    if (action === 'ENTRY') {
      if (isOpen) {
        logState('Option ENTRY ignored (already in position)', {
          symbolId,
          state: runtime.paperCtx.state,
        });
        return { kind: 'IGNORED_ALREADY_OPEN' as const };
      }
      onSignal(runtime.paperCtx, { symbolId, side: 'BUY', ts: nowTs });
      return { kind: 'BUY_SIGNAL' as const };
    }

    // EXIT
    if (!isOpen) {
      onSignal(runtime.paperCtx, { symbolId, side: 'BUY', ts: nowTs });
      return { kind: 'EXIT_CONVERTED_TO_BUY' as const };
    }

    if (ltp == null) {
      // Cannot close without a price. Mark as pending and close on next tick.
      logState('Option EXIT received but no lastPrice; cannot close', {
        symbolId,
      });
      runtime.pendingExit = true;
      runtime.pendingExitRequestedAt = nowTs;
      runtime.pendingReentryAfterExit = true;
      return { kind: 'PENDING_EXIT_NO_PRICE' as const };
    }

    // New rule: EXIT while open => close AND immediately generate a BUY signal
    // based on the current LTP (no wait window).
    closePaperAndReenterNow({
      ctx: runtime.paperCtx,
      symbolId,
      currentPrice: ltp,
      nowTs,
    });
    return { kind: 'CLOSED_AND_REENTERED' as const, exitPrice: ltp };
  }

  handleTickBySymbol(symbolId: string, ltp: number, nowTs: number) {
    const runtime = this.getOrCreate(symbolId);
    runtime.lastPrice = ltp;

    maybeFlushMinute(runtime, nowTs);

    // If an EXIT arrived before the first tick, close as soon as we have a price.
    if (runtime.pendingExit && runtime.paperCtx.position.isOpen) {
      runtime.pendingExit = false;
      runtime.pendingExitRequestedAt = null;
      if (runtime.pendingReentryAfterExit) {
        runtime.pendingReentryAfterExit = false;
        closePaperAndReenterNow({
          ctx: runtime.paperCtx,
          symbolId,
          currentPrice: ltp,
          nowTs,
        });
      } else {
        closePaperAndWaitWindow(runtime.paperCtx, ltp, nowTs);
      }
    }

    const tick = { symbolId, ltp, ts: nowTs };
    onTick(runtime.paperCtx, tick);

    onLiveTick(runtime.liveCtx, nowTs);

    // Live exit based on this instrument's paper cum PnL (strictly positive required)
    const paperPnl = getPaperPnl(runtime.paperCtx, ltp);
    if (
      forceExitIfCumPnlNonPositive(runtime.liveCtx, paperPnl.total, nowTs) ===
      'CLOSE_POSITION'
    ) {
      closeLive(runtime, ltp, nowTs);
    }

    // Detect paper open -> attempt live open (lock uses paper window end when available)
    const paperIsOpenNow = runtime.paperCtx.position.isOpen;
    if (paperIsOpenNow && !runtime.lastPaperWasOpen) {
      const windowEnd =
        runtime.paperCtx.windowStartTs != null && runtime.paperCtx.windowDurationMs != null
          ? runtime.paperCtx.windowStartTs + runtime.paperCtx.windowDurationMs
          : nowTs + 60_000;

      const action = onPaperEntryOpportunity(
        runtime.liveCtx,
        paperPnl.total,
        nowTs,
        windowEnd,
      );

      if (
        action === 'OPEN_POSITION' &&
        runtime.paperCtx.position.entryPrice != null
      ) {
        logState('Options LIVE opening (from paper entry edge)', {
          symbolId,
          paperEntryPrice: runtime.paperCtx.position.entryPrice,
          liveEntryPrice: ltp,
          paperCumPnlTotal: paperPnl.total,
          nowTs,
        });
        // Live entry should reflect the price at the moment we actually go live,
        // not the paper entry price (paper may have entered earlier).
        openLive(runtime, ltp, nowTs);
      }
    } else if (paperIsOpenNow) {
      // Paper already open; live might be IDLE (e.g. lock expired) -> try open
      const action = tryOpenLiveFromPaperPosition(
        runtime.liveCtx,
        paperPnl.total,
        nowTs,
      );
      if (
        action === 'OPEN_POSITION' &&
        runtime.paperCtx.position.entryPrice != null
      ) {
        logState('Options LIVE opening (from paper already-open)', {
          symbolId,
          paperEntryPrice: runtime.paperCtx.position.entryPrice,
          liveEntryPrice: ltp,
          paperCumPnlTotal: paperPnl.total,
          nowTs,
        });
        // Live entry should reflect the price at the moment we actually go live.
        openLive(runtime, ltp, nowTs);
      }
    }

    runtime.lastPaperWasOpen = paperIsOpenNow;

    // Record last snapshot for this minute (written when minute rolls over)
    const paperSnap = getPaperPnl(runtime.paperCtx, ltp);
    const liveSnap = getLivePnl(runtime, ltp);
    runtime.lastMinuteSnapshot = { tsMs: nowTs, paper: paperSnap, live: liveSnap };

    // Detect newly closed trades and persist them immediately.
    if (runtime.paperCtx.trades.length > runtime.lastTradeCount) {
      const newTrades = runtime.paperCtx.trades.slice(runtime.lastTradeCount);
      for (const tr of newTrades) {
        if (
          tr.entryPrice != null &&
          tr.exitPrice != null &&
          tr.pnl != null &&
          tr.closedAt != null
        ) {
          writeOptionsCsvRow({
            symbolId: runtime.instrument.tradingview,
            tsMs: tr.closedAt,
            paper: getPaperPnl(runtime.paperCtx, ltp),
            live: getLivePnl(runtime, ltp),
            paperTrade: {
              side: tr.side,
              openedAt: tr.openedAt ?? tr.closedAt,
              entryPrice: tr.entryPrice,
              exitPrice: tr.exitPrice,
              pnl: tr.pnl,
            },
          });
        }
      }
      runtime.lastTradeCount = runtime.paperCtx.trades.length;
    }
  }

  getSnapshots(): OptionsRuntimeSnapshot[] {
    return Array.from(this.runtimes.values()).map((rt) => {
      const paper = getPaperPnl(rt.paperCtx, rt.lastPrice);
      const live = getLivePnl(rt, rt.lastPrice);
      return {
        tradingview: rt.instrument.tradingview,
        token: rt.instrument.token,
        lot: rt.instrument.lot,
        lastPrice: rt.lastPrice,
        paper: {
          state: rt.paperCtx.state,
          position: rt.paperCtx.position,
          triggers: {
            savedBUYLTP: rt.paperCtx.savedBUYLTP,
            buyEntryTrigger: rt.paperCtx.buyEntryTrigger,
            buyStop: rt.paperCtx.buyStop,
            windowStartTs: rt.paperCtx.windowStartTs,
            windowDurationMs: rt.paperCtx.windowDurationMs,
            waitSourceState: rt.paperCtx.waitSourceState,
          },
          realizedCumPnl: paper.realized,
          unrealizedPnl: paper.unrealized,
          cumPnl: paper.total,
          tradesCount: rt.paperCtx.trades.length,
          recentTrades: rt.paperCtx.trades.slice(-50),
        },
        live: {
          state: rt.liveCtx.state,
          position: rt.liveCtx.position,
          lockUntilTs: rt.liveCtx.lockUntilTs ?? null,
          realizedCumPnl: live.realized,
          unrealizedPnl: live.unrealized,
          cumPnl: live.total,
          recentTrades: rt.liveTradeEvents.slice(-20),
        },
      };
    });
  }

  resetAll(nowTs: number): void {
    for (const rt of this.runtimes.values()) {
      if (rt.paperCtx.position.isOpen && rt.lastPrice != null) {
        closePaperAndWaitWindow(rt.paperCtx, rt.lastPrice, nowTs);
      }
      if (rt.liveCtx.position.isOpen && rt.lastPrice != null) {
        closeLive(rt, rt.lastPrice, nowTs);
        rt.liveCtx.position.isOpen = false;
      }
      // Flush last minute snapshot before reset (best effort).
      if (rt.lastMinuteSnapshot) {
        writeOptionsCsvRow({
          symbolId: rt.instrument.tradingview,
          tsMs: rt.lastMinuteSnapshot.tsMs,
          paper: rt.lastMinuteSnapshot.paper,
          live: rt.lastMinuteSnapshot.live,
        });
      }
      rt.liveRealizedCumPnl = 0;
      rt.liveEntryPrice = null;
      rt.liveTradeEvents = [];
      rt.pendingExit = false;
      rt.pendingExitRequestedAt = null;
      rt.lastPaperWasOpen = false;
      rt.lastTradeCount = rt.paperCtx.trades.length;
      rt.lastMinuteKey = null;
      rt.lastMinuteSnapshot = null;
    }
  }
}
