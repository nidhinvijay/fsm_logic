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

