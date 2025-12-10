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

  if (cumPnl >= 0) {
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

    logState('Live OPEN_POSITION due to non-negative cumPnl', {
      symbolId: live.symbolId,
      cumPnl,
      nowTs,
    });

    return 'OPEN_POSITION';
  }

  // cumPnl < 0  → close live and lock until end of this window
  if (live.state === LiveState.POSITION) {
    live.position.isOpen = false;
    live.position.entryPrice = null;
    live.position.openedAt = null;
  }

  live.state = LiveState.LOCKED;
  live.lockUntilTs = paperWindowEndTs;

  logState('Live CLOSE_POSITION and LOCK due to negative cumPnl', {
    symbolId: live.symbolId,
    cumPnl,
    nowTs,
    lockUntilTs: paperWindowEndTs,
  });

  // we return CLOSE_POSITION only if we actually had a position
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
