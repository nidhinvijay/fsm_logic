// src/liveEngine.ts
import { LiveContext, LiveState } from './liveStates';
import { logState } from './logger';

export type LiveAction = 'OPEN_POSITION' | 'CLOSE_POSITION' | 'NONE';

// create live FSM context for a side (we'll have one for LONG, one for SHORT)
export const createLiveContext = (symbolId: string): LiveContext => {
  const ctx: LiveContext = {
    symbolId,
    state: LiveState.IDLE,
    position: {
      isOpen: false,
      entryPrice: null,
      openedAt: null,
    },
    lockUntilTs: undefined,
  };

  logState('Live FSM created', { symbolId, state: ctx.state });
  return ctx;
};

// called when PAPER wants to enter a trade (either long or short) for this side
// paperWindowEndTs = end time of current 60s window (for lock)
export const onPaperEntryOpportunity = (
  live: LiveContext,
  cumPnl: number,
  nowTs: number,
  paperWindowEndTs: number,
): LiveAction => {
  // if locked for this window, do nothing
  if (
    live.state === LiveState.LOCKED &&
    live.lockUntilTs != null &&
    nowTs < live.lockUntilTs
  ) {
    logState('Live is locked, ignoring paper entry opportunity', {
      symbolId: live.symbolId,
      cumPnl,
      nowTs,
      lockUntilTs: live.lockUntilTs,
    });
    return 'NONE';
  }

  // --- ENTRY RULE: allow live only if cumPnl > 0 (strictly positive) ---
  if (cumPnl > 0) {
    // allowed to trade live
    if (live.state === LiveState.POSITION) {
      // already in a position, keep it
      logState('Live already in POSITION, keeping position', {
        symbolId: live.symbolId,
        cumPnl,
      });
      return 'NONE';
    }

    // open new live position
    live.state = LiveState.POSITION;
    live.position.isOpen = true;
    live.position.entryPrice = null; // caller will set actual price
    live.position.openedAt = nowTs;
    live.lockUntilTs = undefined;

    logState('Live OPEN_POSITION due to positive cumPnl', {
      symbolId: live.symbolId,
      cumPnl,
      nowTs,
    });

    return 'OPEN_POSITION';
  }

  // --- EXIT RULE: cumPnl <= 0 ---
  // If there is an open live position, close it and lock until end of this paper window.
  // If there is no position, do nothing (no new lock).
  const hadPosition = live.state === LiveState.POSITION && live.position.isOpen;
  if (!hadPosition) {
    logState('Live cumPnl <= 0 but no open position; leaving live state unchanged', {
      symbolId: live.symbolId,
      cumPnl,
      nowTs,
    });
    return 'NONE';
  }

  live.position.isOpen = false;
  live.position.entryPrice = null;
  live.position.openedAt = null;

  live.state = LiveState.LOCKED;
  live.lockUntilTs = paperWindowEndTs;

  logState('Live CLOSE_POSITION and LOCK due to non-positive cumPnl', {
    symbolId: live.symbolId,
    cumPnl,
    nowTs,
    lockUntilTs: paperWindowEndTs,
  });

  return 'CLOSE_POSITION';
};

// call this on each tick to see if lock period is over
export const onLiveTick = (live: LiveContext, nowTs: number): void => {
  if (
    live.state === LiveState.LOCKED &&
    live.lockUntilTs != null &&
    nowTs >= live.lockUntilTs
  ) {
    live.state = LiveState.IDLE;
    live.lockUntilTs = undefined;
    logState('Live lock expired, back to IDLE', {
      symbolId: live.symbolId,
      nowTs,
    });
  }
};

// Immediate exit helper: call on each tick with current cumPnl.
// If cumPnl <= 0 and a live position is open, we close immediately
// and lock for 60 seconds from now.
export const forceExitIfCumPnlNonPositive = (
  live: LiveContext,
  cumPnl: number,
  nowTs: number,
): LiveAction => {
  if (cumPnl > 0) return 'NONE';
  if (live.state !== LiveState.POSITION || !live.position.isOpen) {
    return 'NONE';
  }

  live.position.isOpen = false;
  live.position.entryPrice = null;
  live.position.openedAt = null;

  live.state = LiveState.LOCKED;
  live.lockUntilTs = nowTs + 60_000;

  logState('Live FORCE CLOSE due to non-positive cumPnl', {
    symbolId: live.symbolId,
    cumPnl,
    nowTs,
    lockUntilTs: live.lockUntilTs,
  });

  return 'CLOSE_POSITION';
};

// Try to open a live position based on current cumPnl and time.
// Used when paper is already in a position and live is IDLE.
export const tryOpenLiveFromPaperPosition = (
  live: LiveContext,
  cumPnl: number,
  nowTs: number,
): LiveAction => {
  // require strictly positive cumPnl
  if (cumPnl <= 0) return 'NONE';

  // if locked and lock not expired, do nothing
  if (
    live.state === LiveState.LOCKED &&
    live.lockUntilTs != null &&
    nowTs < live.lockUntilTs
  ) {
    return 'NONE';
  }

  // already in live position
  if (live.state === LiveState.POSITION && live.position.isOpen) {
    return 'NONE';
  }

  // open live position
  live.state = LiveState.POSITION;
  live.position.isOpen = true;
  live.position.entryPrice = null; // caller sets actual entry
  live.position.openedAt = nowTs;
  live.lockUntilTs = undefined;

  logState('Live OPEN_POSITION from paper position and positive cumPnl', {
    symbolId: live.symbolId,
    cumPnl,
    nowTs,
  });

  return 'OPEN_POSITION';
};
