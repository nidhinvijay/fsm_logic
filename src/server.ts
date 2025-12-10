import express from 'express';
import { createFSM } from './fsmInit';
import { onSignal, onTick } from './fsmEngine';
import { FSMContext } from './fsmStates';
import { round2, calcCumPnl } from './pnl';
import {
  createLiveContext,
  onPaperEntryOpportunity,
  onLiveTick,
} from './liveEngine';
import { LiveContext } from './liveStates';
import {
  registerPaperLongOpen,
  registerPaperShortOpen,
} from './paperHooks';

const app = express();
app.use(express.json());
app.use(express.static('public'));

// --- Paper FSMs (separate BUY + SELL) ---

// BUY side (LONG paper FSM)
const paperLongCtx: FSMContext = createFSM('BTCUSD');
// SELL side (SHORT paper FSM)
const paperShortCtx: FSMContext = createFSM('BTCUSD');

// --- Live FSMs (LONG + SHORT) ---

const liveLongCtx: LiveContext = createLiveContext('BTCUSD-LONG');
const liveShortCtx: LiveContext = createLiveContext('BTCUSD-SHORT');

// --- Auto tick simulation state ---

type AutoMode = 'PAUSE' | 'UP' | 'DOWN' | 'RANDOM';

let currentPrice = 100;
let autoMode: AutoMode = 'PAUSE';

const TICK_STEP = 0.5;
const TICK_INTERVAL_MS = 1000;

// helper: total cum PnL from both paper engines
function getTotalCumPnl(): number {
  const longPnl = calcCumPnl(paperLongCtx.trades);
  const shortPnl = calcCumPnl(paperShortCtx.trades);
  return round2(longPnl + shortPnl);
}

// build view object for UI for each paper FSM
function buildPaperView(ctx: FSMContext) {
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
    cumPnl: calcCumPnl(ctx.trades),
  };
}

// state for /state endpoint
function getStateSnapshot() {
  return {
    currentPrice,
    autoMode,

    cumPnlTotal: getTotalCumPnl(),

    paperLong: buildPaperView(paperLongCtx),
    paperShort: buildPaperView(paperShortCtx),

    liveLong: {
      state: liveLongCtx.state,
      position: liveLongCtx.position,
      lockUntilTs: liveLongCtx.lockUntilTs ?? null,
    },

    liveShort: {
      state: liveShortCtx.state,
      position: liveShortCtx.position,
      lockUntilTs: liveShortCtx.lockUntilTs ?? null,
    },
  };
}

// --- Auto tick loop: send ticks to BOTH paper FSMs + live FSMs ---

setInterval(() => {
  if (autoMode === 'PAUSE') return;

  if (autoMode === 'UP') {
    currentPrice += TICK_STEP;
  } else if (autoMode === 'DOWN') {
    currentPrice -= TICK_STEP;
  } else {
    // RANDOM
    const dir = Math.random() < 0.5 ? -1 : 1;
    currentPrice += dir * TICK_STEP;
  }

  const now = Date.now();

  const tick = {
    symbolId: 'BTCUSD',
    ltp: currentPrice,
    ts: now,
  };

  // send tick to BOTH paper engines
  onTick(paperLongCtx, tick);
  onTick(paperShortCtx, tick);

  // check if live locks expire
  onLiveTick(liveLongCtx, now);
  onLiveTick(liveShortCtx, now);
}, TICK_INTERVAL_MS);

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
  } else if (action === 'CLOSE_POSITION') {
    console.log('LIVE LONG: Would CLOSE LONG (cumPnl < 0)');
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
  } else if (action === 'CLOSE_POSITION') {
    console.log('LIVE SHORT: Would CLOSE SHORT (cumPnl < 0)');
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
  } else {
    onSignal(paperShortCtx, {
      symbolId: 'BTCUSD',
      side,
      ts: now,
    });
  }

  return res.json({
    message: 'Signal processed',
    state: getStateSnapshot(),
  });
});

// POST /webhook  { message: string }
// Example payloads:
//  { "message": "Accepted Entry + priorRisePct= 0.00 | stopPx=100 | sym=BTCUSD" }
//  { "message": "Accepted Exit+ priorRisePct= 0.00 | stopPx=100 | sym=BTCUSD" }
app.post('/webhook', (req, res) => {
  const { message } = req.body as { message?: string };

  if (typeof message !== 'string') {
    return res.status(400).json({ error: 'message must be a string' });
  }

  // Basic parsing
  const isEntry = message.includes('Accepted Entry');
  const isExit = message.includes('Accepted Exit');
  const symMatch = message.match(/sym=([A-Z0-9]+)/);
  const stopMatch = message.match(/stopPx=([\d.]+)/);

  const symbol = symMatch?.[1] ?? 'BTCUSD';
  const stopPx = stopMatch ? Number(stopMatch[1]) : undefined;

  if (symbol !== 'BTCUSD') {
    // for now we only handle BTCUSD
    return res.json({ message: 'ignored symbol', symbol });
  }

  const now = Date.now();

  if (isEntry) {
    // Treat BTCUSD "Accepted Entry" as BUY signal → paper LONG FSM
    onSignal(paperLongCtx, {
      symbolId: 'BTCUSD',
      side: 'BUY',
      ts: now,
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

    return res.json({
      message: 'Exit processed as SELL for BTCUSD (paper SHORT)',
      stopPx,
      state: getStateSnapshot(),
    });
  }

  return res.json({
    message: 'Webhook message received but no condition matched',
    state: getStateSnapshot(),
  });
});


// POST /tick  { ltp: number }  (optional manual tick)
app.post('/tick', (req, res) => {
  const { ltp } = req.body as { ltp?: number };

  if (typeof ltp !== 'number' || Number.isNaN(ltp)) {
    return res.status(400).json({ error: 'ltp must be a number' });
  }

  currentPrice = ltp;
  const now = Date.now();

  const tick = {
    symbolId: 'BTCUSD',
    ltp: currentPrice,
    ts: now,
  };

  onTick(paperLongCtx, tick);
  onTick(paperShortCtx, tick);

  onLiveTick(liveLongCtx, now);
  onLiveTick(liveShortCtx, now);

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

  if (typeof ltp === 'number' && !Number.isNaN(ltp)) {
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
  res.json(getStateSnapshot());
});

// Start server
const PORT = 3000;
app.listen(PORT, () => {
  console.log(`FSM demo server running at http://localhost:${PORT}`);
});
