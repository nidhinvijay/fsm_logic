# Production (no `ts-node`)

## Build

```bash
npm ci
npm run build
```

Build output is written to `dist/`:
- Server: `dist/src/server.js`
- Scripts: `dist/scripts/*.js`

## Run with PM2

```bash
pm2 delete fsm || true
pm2 start dist/src/server.js --name fsm
pm2 save
```

## Zerodha ticks (optional, PM2)

```bash
pm2 delete zerodha-ticks || true
pm2 start dist/scripts/zerodhaTicks.js --name zerodha-ticks
pm2 save
```

## Zerodha executor (options live orders, PM2)

This is a separate local service that calls Kite Connect `placeOrder()` (IOC limit).

Env (example):
- `ZERODHA_EXEC_PORT=3200`
- `ZERODHA_EXEC_TOKEN=...` (shared secret for `/order`)
- `TRADING_ENABLED=0` (default; set to `1` only when ready)
- `OPTIONS_MAX_PREMIUM_INR=25000` (optional safety cap; skips BUY if premium*qty exceeds)

Start:
```bash
pm2 delete zerodha-exec || true
pm2 start dist/scripts/zerodhaExec.js --name zerodha-exec
pm2 save
```

FSM toggle (default OFF):
- `POST /options/execution` with `{ "enabled": true, "token": "..." }`
- If set, protect with `OPTIONS_EXEC_CONTROL_TOKEN=...`

FSM → executor config:
- `ZERODHA_EXEC_URL=http://127.0.0.1:3200`
- `ZERODHA_EXEC_TOKEN=...` (must match executor)

## Capture + Replay (optional debugging)

If you want to debug a full trading session without waiting for the next day, you can run a **separate** capture proxy that:
1) logs incoming TradingView signals + Zerodha ticks to CSV, and
2) forwards them to the normal FSM server unchanged.

### Alternative (no URL changes): capture inside `fsm`

You can also capture *after the data reaches the FSM* (no webhook URL changes) by enabling capture logging in `fsm`.

Env:
- `CAPTURE_ENABLED=1`
- `CAPTURE_DIR=logs/capture`

This writes:
- `logs/capture/signals-YYYY-MM-DD.csv` (webhooks received by `fsm`)
- `logs/capture/ticks-YYYY-MM-DD.csv` (Zerodha ticks received by `fsm`)

### Capture proxy

Start (dev):
```bash
ts-node scripts/captureProxy.ts
```

Start (prod):
```bash
node dist/scripts/captureProxy.js
```

Env:
- `CAPTURE_PORT` (default `3100`)
- `FSM_BASE_URL` (default `http://127.0.0.1:3000`)
- `CAPTURE_DIR` (default `logs/capture`)

Endpoints:
- `POST /webhook` → captures signals, forwards to `${FSM_BASE_URL}/webhook`
- `POST /zerodha/tick` → captures ticks, forwards to `${FSM_BASE_URL}/zerodha/tick`
- `GET /health`

Output files:
- `logs/capture/signals-YYYY-MM-DD.csv`
- `logs/capture/ticks-YYYY-MM-DD.csv`

### Replay options session

After market close, replay captured options ticks/signals offline:

```bash
ts-node scripts/replayOptions.ts --date YYYY-MM-DD --captureDir logs/capture
```

Optional filter:
```bash
ts-node scripts/replayOptions.ts --date YYYY-MM-DD --captureDir logs/capture --symbol NIFTY251216P26100
```

Replay output:
- Creates `replay-output/<date>-<runId>/`
- Writes generated options CSVs under `replay-output/<...>/logs/`
- Writes `replay-output/<...>/snapshots.json`
