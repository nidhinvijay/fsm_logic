import { createFSM } from './fsmInit';
import { onSignal, onTick } from './fsmEngine';

// Create FSM instance for BTCUSD
const ctx = createFSM('BTCUSD');

// Helper to simulate timestamps
let now = Date.now();

// Send BUY_SIGNAL
onSignal(ctx, {
  symbolId: 'BTCUSD',
  side: 'BUY',
  ts: now,
});

// ---- FIRST TICK AFTER BUY_SIGNAL ----
now += 1000;
onTick(ctx, {
  symbolId: 'BTCUSD',
  ltp: 100,
  ts: now,
});

// ---- ENTRY WINDOW: price goes UP and hits trigger ----
now += 1000;
onTick(ctx, {
  symbolId: 'BTCUSD',
  ltp: 100.6, // 100 + 0.5 trigger = 100.5 → enter LONG
  ts: now,
});

// ---- PROFIT WINDOW: price goes DOWN and hits STOP ----
now += 1000;
onTick(ctx, {
  symbolId: 'BTCUSD',
  ltp: 99.4, // stop = 99.5 → close LONG
  ts: now,
});

// Continue simulation...
now += 2000;
onTick(ctx, {
  symbolId: 'BTCUSD',
  ltp: 99.7,
  ts: now,
});

// ... your existing ticks above ...

// Continue simulation...
now += 2000;
onTick(ctx, {
  symbolId: 'BTCUSD',
  ltp: 99.7,
  ts: now,
});

// Let WAIT_WINDOW finish so it can move to WAIT_FOR_BUYENTRY
now += 59_000;
onTick(ctx, {
  symbolId: 'BTCUSD',
  ltp: 99.8,
  ts: now,
});

// Now inside WAIT_FOR_BUYENTRY, if price crosses trigger again, it will re-open LONG
now += 1000;
onTick(ctx, {
  symbolId: 'BTCUSD',
  ltp: 100.6, // above buyEntryTrigger (100.5)
  ts: now,
});


console.log('Simulation complete. Check logs/fsm.log');
