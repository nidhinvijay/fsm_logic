import { loadEnvOnce, reloadEnv } from '../src/loadEnv';
import fetch from 'node-fetch';
import { KiteTicker } from 'kiteconnect';
import { INSTRUMENTS_DATA } from '../src/instruments';

type KiteTick = {
  instrument_token: number;
  last_price: number;
};

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env var: ${name}`);
  return value;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForEnv(names: string[]): Promise<void> {
  loadEnvOnce();
  while (true) {
    const missing = names.filter((n) => !process.env[n]);
    if (missing.length === 0) return;
    console.log('[zerodha-ticks] waiting for env vars', { missing });
    await sleep(5000);
    reloadEnv();
  }
}

function getTokens(): number[] {
  const override = process.env.KITE_TOKENS;
  if (override && override.trim()) {
    return override
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n));
  }
  return INSTRUMENTS_DATA.map((i) => i.token);
}

async function postTick(params: {
  tickUrl: string;
  token: number;
  ltp: number;
  ts: number;
}): Promise<void> {
  await fetch(params.tickUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token: params.token,
      ltp: params.ltp,
      ts: params.ts,
    }),
  });
}

async function main(): Promise<void> {
  await waitForEnv(['KITE_API_KEY', 'KITE_ACCESS_TOKEN']);
  const apiKey = requireEnv('KITE_API_KEY');
  const accessToken = requireEnv('KITE_ACCESS_TOKEN');
  const tickUrl = process.env.FSM_TICK_URL ?? 'http://localhost:3000/zerodha/tick';

  const tokens = getTokens();
  if (!tokens.length) throw new Error('No tokens configured');

  console.log('[zerodha-ticks] starting', {
    tickUrl,
    tokens: tokens.length,
  });

  const ticker = new KiteTicker({
    api_key: apiKey,
    access_token: accessToken,
  } as any);

  const lastSentAtByToken = new Map<number, number>();
  const MIN_SEND_INTERVAL_MS = 900; // ~1/minute resolution at server; keep reasonable rate

  ticker.on('connect', () => {
    console.log('[zerodha-ticks] connected; subscribing', { tokens: tokens.length });
    ticker.subscribe(tokens);
    try {
      ticker.setMode(ticker.modeLTP, tokens);
    } catch (e) {
      console.warn('[zerodha-ticks] setMode failed (continuing)', String(e));
    }
  });

  ticker.on('disconnect', (err: unknown) => {
    console.warn('[zerodha-ticks] disconnected', String(err ?? ''));
  });

  ticker.on('error', (err: unknown) => {
    console.error('[zerodha-ticks] error', String(err ?? ''));
  });

  ticker.on('reconnect', (attempt: number, interval: number) => {
    console.log('[zerodha-ticks] reconnecting', { attempt, interval });
  });

  ticker.on('ticks', async (ticks: KiteTick[]) => {
    const now = Date.now();
    const posts: Promise<void>[] = [];

    for (const t of ticks) {
      const token = Number((t as any).instrument_token);
      const ltp = Number((t as any).last_price);
      if (!Number.isFinite(token) || !Number.isFinite(ltp)) continue;

      const last = lastSentAtByToken.get(token) ?? 0;
      if (now - last < MIN_SEND_INTERVAL_MS) continue;

      lastSentAtByToken.set(token, now);
      posts.push(
        postTick({
          tickUrl,
          token,
          ltp,
          ts: now,
        }).catch((e) => {
          console.warn('[zerodha-ticks] failed POST /zerodha/tick', {
            token,
            error: String(e),
          });
        }),
      );
    }

    if (posts.length) await Promise.all(posts);
  });

  ticker.connect();
}

main().catch((e) => {
  console.error('[zerodha-ticks] fatal', String(e));
  process.exit(1);
});
