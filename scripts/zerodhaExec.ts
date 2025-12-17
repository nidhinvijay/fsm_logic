import { loadEnvOnce, reloadEnv } from '../src/loadEnv';
import express from 'express';
import { KiteConnect } from 'kiteconnect';

type ExecOrderRequest = {
  exchange: string;
  tradingsymbol: string;
  transaction_type: string;
  quantity: number;
  price: number;
};

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env var: ${name}`);
  return value;
}

function getAuthToken(): string | null {
  const t = process.env.ZERODHA_EXEC_TOKEN;
  if (!t || !t.trim()) return null;
  return t.trim();
}

function isAuthorized(req: express.Request): boolean {
  const expected = getAuthToken();
  if (!expected) return false;

  const header = String(req.headers.authorization || '');
  if (header.toLowerCase().startsWith('bearer ')) {
    const provided = header.slice('bearer '.length).trim();
    return provided === expected;
  }
  const provided = String(req.headers['x-exec-token'] || '').trim();
  return provided === expected;
}

function getKite(): KiteConnect {
  loadEnvOnce();
  const apiKey = requireEnv('KITE_API_KEY');
  const accessToken = requireEnv('KITE_ACCESS_TOKEN');
  const kc = new KiteConnect({ api_key: apiKey } as any);
  kc.setAccessToken(accessToken);
  return kc;
}

async function main(): Promise<void> {
  const port = Number(process.env.ZERODHA_EXEC_PORT || '3200');
  const app = express();

  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.json({
      ok: true,
      port,
      tradingEnabled: process.env.TRADING_ENABLED === '1',
      hasExecToken: Boolean(getAuthToken()),
      envPath: reloadEnv().path,
    });
  });

  app.post('/order', async (req, res) => {
    if (!isAuthorized(req)) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    if (process.env.TRADING_ENABLED !== '1') {
      return res.status(403).json({ error: 'trading_disabled' });
    }

    const body = req.body as Partial<ExecOrderRequest>;
    const exchange = String(body.exchange || '').trim();
    const tradingsymbol = String(body.tradingsymbol || '').trim();
    const transaction_type = String(body.transaction_type || '').trim().toUpperCase();
    const quantity = Number(body.quantity);
    const price = Number(body.price);

    if (!exchange) return res.status(400).json({ error: 'exchange required' });
    if (!tradingsymbol) return res.status(400).json({ error: 'tradingsymbol required' });
    if (transaction_type !== 'BUY' && transaction_type !== 'SELL') {
      return res.status(400).json({ error: 'transaction_type must be BUY or SELL' });
    }
    if (!Number.isFinite(quantity) || quantity <= 0) {
      return res.status(400).json({ error: 'quantity must be > 0' });
    }
    if (!Number.isFinite(price) || price <= 0) {
      return res.status(400).json({ error: 'price must be > 0' });
    }

    try {
      const kc = getKite();
      const order = await kc.placeOrder(kc.VARIETY_REGULAR, {
        exchange: exchange as any,
        tradingsymbol,
        transaction_type: transaction_type as any,
        quantity,
        product: kc.PRODUCT_MIS,
        order_type: kc.ORDER_TYPE_LIMIT,
        price,
        validity: kc.VALIDITY_IOC,
      } as any);

      return res.json({ ok: true, order });
    } catch (err) {
      return res.status(502).json({ error: 'place_order_failed', detail: String(err) });
    }
  });

  app.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`[zerodha-exec] listening on :${port}`);
    // eslint-disable-next-line no-console
    console.log(`[zerodha-exec] trading ${process.env.TRADING_ENABLED === '1' ? 'ENABLED' : 'DISABLED'}`);
    // eslint-disable-next-line no-console
    console.log(`[zerodha-exec] token ${getAuthToken() ? 'set' : 'missing'} (ZERODHA_EXEC_TOKEN)`);
  });
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('[zerodha-exec] fatal', String(e));
  process.exit(1);
});

