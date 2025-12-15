import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { KiteConnect } from 'kiteconnect';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env var: ${name}`);
  return value;
}

function upsertEnvLine(contents: string, key: string, value: string): string {
  const lines = contents.split(/\r?\n/);
  const prefix = `${key}=`;
  let found = false;

  const next = lines.map((line) => {
    if (line.startsWith(prefix)) {
      found = true;
      return `${key}=${value}`;
    }
    return line;
  });

  if (!found) {
    if (next.length && next[next.length - 1].trim() !== '') next.push('');
    next.push(`${key}=${value}`);
  }

  return next.join('\n');
}

async function main(): Promise<void> {
  const apiKey = requireEnv('KITE_API_KEY');
  const apiSecret = requireEnv('KITE_API_SECRET');
  const requestToken = requireEnv('KITE_REQUEST_TOKEN');

  const envPath =
    process.env.ZERODHA_ENV_PATH ??
    path.resolve(process.cwd(), '.env.zerodha');

  const loginUrl = `https://kite.zerodha.com/connect/login?v=3&api_key=${encodeURIComponent(apiKey)}`;

  console.log('[zerodha-session] login URL (get request_token):');
  console.log(loginUrl);

  const kc = new KiteConnect({ api_key: apiKey } as any);
  const response = await kc.generateSession(requestToken, apiSecret);
  const accessToken = String((response as any).access_token || '');
  if (!accessToken) throw new Error('generateSession did not return access_token');

  const generatedAtUtc = new Date().toISOString();

  const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  let updated = existing;
  updated = upsertEnvLine(updated, 'KITE_API_KEY', apiKey);
  updated = upsertEnvLine(updated, 'KITE_API_SECRET', apiSecret);
  updated = upsertEnvLine(updated, 'KITE_ACCESS_TOKEN', accessToken);
  updated = upsertEnvLine(updated, 'KITE_ACCESS_TOKEN_GENERATED_AT_UTC', generatedAtUtc);

  fs.writeFileSync(envPath, updated, 'utf8');

  console.log('[zerodha-session] wrote access token to:', envPath);
  console.log('[zerodha-session] access token generated at (UTC):', generatedAtUtc);

  const pm2Name = process.env.PM2_PROCESS_NAME;
  const pm2Restart = process.env.PM2_RESTART === '1';
  if (pm2Restart && pm2Name) {
    console.log('[zerodha-session] pm2 restart requested:', pm2Name);
    console.log(`pm2 restart ${pm2Name}`);
  } else {
    console.log('[zerodha-session] next: restart zerodha ticks process');
    console.log('  pm2 restart zerodha-ticks');
  }
}

main().catch((e) => {
  console.error('[zerodha-session] fatal:', String(e));
  process.exit(1);
});
