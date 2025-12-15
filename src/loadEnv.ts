import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

let loadedOnce = false;

function resolveEnvPath(): string | null {
  const explicit = process.env.DOTENV_CONFIG_PATH || process.env.ZERODHA_ENV_PATH;
  if (explicit && explicit.trim()) return explicit;

  const cwd = process.cwd();
  const zerodhaPath = path.resolve(cwd, '.env.zerodha');
  if (fs.existsSync(zerodhaPath)) return zerodhaPath;

  const defaultPath = path.resolve(cwd, '.env');
  if (fs.existsSync(defaultPath)) return defaultPath;

  return null;
}

export function loadEnvOnce(): { path: string | null } {
  if (loadedOnce) return { path: null };
  loadedOnce = true;

  const envPath = resolveEnvPath();
  if (envPath) dotenv.config({ path: envPath });
  else dotenv.config();

  return { path: envPath };
}

export function reloadEnv(): { path: string | null } {
  const envPath = resolveEnvPath();
  if (envPath) dotenv.config({ path: envPath, override: true });
  return { path: envPath };
}

