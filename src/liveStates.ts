// src/liveStates.ts
export enum LiveState {
  IDLE = 'IDLE',        // no live position, allowed to trade
  POSITION = 'POSITION',// live position is open
  LOCKED = 'LOCKED',    // blocked until window end
}

export interface LivePosition {
  isOpen: boolean;
  entryPrice: number | null;
  openedAt: number | null;
}

export interface LiveContext {
  symbolId: string;
  state: LiveState;
  position: LivePosition;

  // if LOCKED, we stay idle until this timestamp
  lockUntilTs?: number;
}
