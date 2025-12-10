// src/deltaFeed.ts
import fetch from 'node-fetch';
import { FSMContext } from './fsmStates';
import { LiveContext } from './liveStates';
import { onTick } from './fsmEngine';
import { onLiveTick } from './liveEngine';
import { logger } from './logger';

const DELTA_BASE_URL = 'https://api.delta.exchange';
const SYMBOL = 'BTCUSD';
const INTERVAL_MS = 1000; // 1s polling

export function startDeltaFeed(
  paperLong: FSMContext,
  paperShort: FSMContext,
  liveLong: LiveContext,
  liveShort: LiveContext,
  setCurrentPrice: (p: number) => void,
) {
  setInterval(async () => {
    try {
      // Futures / perpetual tickers – BTCUSD
      const url = `${DELTA_BASE_URL}/v2/tickers?contract_types=perpetual_futures&symbol=${SYMBOL}`;
      const res = await fetch(url);

      if (!res.ok) {
        logger.warn('Delta ticker HTTP error', { status: res.status });
        return;
      }

      const body = (await res.json()) as any;
      const ticker = Array.isArray(body.result)
        ? body.result.find((t: any) => t.symbol === SYMBOL)
        : body.result;
      if (!ticker || ticker.symbol !== SYMBOL) {
        logger.warn('Delta ticker: BTCUSD not found in result', body);
        return;
      }

      // mark_price is what Delta docs and examples use for LTP :contentReference[oaicite:1]{index=1}
      const price = Number(ticker.mark_price ?? ticker.last_price);
      if (!Number.isFinite(price)) {
        logger.warn('Delta ticker: bad price', { ticker });
        return;
      }

      const now = Date.now();
      setCurrentPrice(price);

      const tick = { symbolId: SYMBOL, ltp: price, ts: now };

      // feed both paper engines
      onTick(paperLong, tick);
      onTick(paperShort, tick);

      // update live engines (for lock expiry etc.)
      onLiveTick(liveLong, now);
      onLiveTick(liveShort, now);
    } catch (err) {
      logger.error('Delta ticker fetch failed', { err });
    }
  }, INTERVAL_MS);
}
