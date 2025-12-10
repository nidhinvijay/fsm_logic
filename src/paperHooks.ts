// src/paperHooks.ts
import { FSMContext } from './fsmStates';

export type PaperOpenCallback = (
  ctx: FSMContext,
  nowTs: number,
  paperWindowEndTs: number,
  entryLtp: number,
) => void;

// Called when paper opens LONG
export let onPaperLongOpen: PaperOpenCallback | undefined = undefined;
// Called when paper opens SHORT
export let onPaperShortOpen: PaperOpenCallback | undefined = undefined;

export const registerPaperLongOpen = (cb: PaperOpenCallback): void => {
  onPaperLongOpen = cb;
};

export const registerPaperShortOpen = (cb: PaperOpenCallback): void => {
  onPaperShortOpen = cb;
};
