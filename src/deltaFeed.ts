import WebSocket from 'ws';
import { FSMContext } from './fsmStates';
import { LiveContext } from './liveStates';
import { logger } from './logger';

// Delta India production WS:
// https://docs.delta.exchange/#websocket-feed
const DELTA_WS_URL = 'wss://socket.india.delta.exchange';
const SYMBOL = 'BTCUSD';

// heartbeat to keep connection alive
const HEARTBEAT_TIMEOUT_MS = 35_000;
// reconnect delay
const RECONNECT_MS = 3_000;

export function startDeltaFeed(
  _paperLong: FSMContext,
  _paperShort: FSMContext,
  _liveLong: LiveContext,
  _liveShort: LiveContext,
  setCurrentPrice: (p: number) => void,
  onPrice: (p: number, nowTs: number) => void,
  shouldProcess: () => boolean,
) {
  let ws: WebSocket | null = null;
  let heartbeatTimeout: NodeJS.Timeout | null = null;

  const connect = () => {
    logger.info('Connecting to Delta WebSocket');
    ws = new WebSocket(DELTA_WS_URL);
    let loggedFirstData = false;

    ws.on('open', () => {
      logger.info('Delta WebSocket connected');

      // Enable server-sent heartbeat messages (recommended by Delta docs).
      ws?.send(JSON.stringify({ type: 'enable_heartbeat' }));

      // Subscribe to best bid/ask (L1 orderbook).
      // Publish interval: 100ms (max 5s if unchanged).
      ws?.send(
        JSON.stringify({
          type: 'subscribe',
          payload: {
            channels: [
              {
                name: 'l1_orderbook',
                symbols: [SYMBOL],
              },
            ],
          },
        }),
      );
      resetHeartbeatTimeout();
    });

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());

        if (msg && msg.type === 'heartbeat') {
          resetHeartbeatTimeout();
          return;
        }

        if (!shouldProcess()) return;

        // Delta docs show `l1_orderbook` (full fields) and also mention legacy `l1ob` shorthand.
        // Handle both to avoid silently missing updates due to schema differences.
        //
        // l1_orderbook sample:
        // { type:"l1_orderbook", symbol:"BTCUSD", best_bid:"...", best_ask:"..." }
        //
        // l1ob sample (docs comment):
        // { type:"l1ob", s:"BTCUSD", d:[BestAskPrice,BestAskSize,BestBidPrice,BestBidSize], ... }
        const type = String(msg?.type || '');
        const symbol = String(msg?.symbol || msg?.s || '');
        if (symbol !== SYMBOL) return;

        let bid: number = Number.NaN;
        let ask: number = Number.NaN;

        if (type === 'l1_orderbook') {
          bid = Number(msg.best_bid);
          ask = Number(msg.best_ask);
        } else if (type === 'l1ob') {
          const d = Array.isArray(msg.d) ? msg.d : null;
          // [BestAskPrice, BestAskSize, BestBidPrice, BestBidSize]
          ask = d ? Number(d[0]) : Number.NaN;
          bid = d ? Number(d[2]) : Number.NaN;
        } else {
          return;
        }

        const price =
          Number.isFinite(bid) && Number.isFinite(ask)
            ? (bid + ask) / 2
            : Number.isFinite(bid)
              ? bid
              : Number.isFinite(ask)
                ? ask
                : NaN;
        if (!Number.isFinite(price)) {
          logger.warn('Delta WS: bad price', msg);
          return;
        }

        if (!loggedFirstData) {
          loggedFirstData = true;
          logger.info('Delta WS first price', { type, symbol, bid, ask, price });
        }

        const now = Date.now();
        setCurrentPrice(price);
        onPrice(price, now);
      } catch (err) {
        logger.error('Delta WS message error', { err });
      }
    });

    ws.on('close', (code, reason) => {
      logger.warn('Delta WS closed', { code, reason: reason.toString() });
      cleanup();
      setTimeout(connect, RECONNECT_MS);
    });

    ws.on('error', (err) => {
      logger.error('Delta WS error', { err });
      ws?.close();
    });
  };

  const resetHeartbeatTimeout = () => {
    if (heartbeatTimeout) clearTimeout(heartbeatTimeout);
    heartbeatTimeout = setTimeout(() => {
      logger.warn('Delta WS heartbeat timeout; reconnecting');
      try {
        ws?.close();
      } catch {
        // ignore
      }
    }, HEARTBEAT_TIMEOUT_MS);
  };

  const cleanup = () => {
    if (heartbeatTimeout) clearTimeout(heartbeatTimeout);
    heartbeatTimeout = null;
    ws = null;
  };

  connect();
}
