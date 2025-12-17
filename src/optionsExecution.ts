import fetch from 'node-fetch';
import { logState } from './logger';

let enabled = false;

export function setOptionsExecutionEnabled(next: boolean): void {
  enabled = next;
}

export function getOptionsExecutionState(): { enabled: boolean } {
  return { enabled };
}

function getMaxPremiumInr(): number | null {
  const raw = (process.env.OPTIONS_MAX_PREMIUM_INR || '').trim();
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function getExecBaseUrl(): string {
  return (process.env.ZERODHA_EXEC_URL || 'http://127.0.0.1:3200').trim();
}

function getExecToken(): string | null {
  const t = (process.env.ZERODHA_EXEC_TOKEN || '').trim();
  return t ? t : null;
}

export async function sendZerodhaExecOrder(params: {
  exchange: string;
  tradingsymbol: string;
  transactionType: 'BUY' | 'SELL';
  quantity: number;
  refLtp: number;
}): Promise<void> {
  if (!enabled) return;

  const baseUrl = getExecBaseUrl();
  const token = getExecToken();
  if (!token) {
    logState('Options execution enabled but ZERODHA_EXEC_TOKEN missing; skipping order', {
      exchange: params.exchange,
      tradingsymbol: params.tradingsymbol,
      transactionType: params.transactionType,
      quantity: params.quantity,
      refLtp: params.refLtp,
    });
    return;
  }

  const price =
    params.transactionType === 'BUY'
      ? params.refLtp + 1
      : params.refLtp - 1;

  // Safety: avoid placing BUY orders whose notional premium exceeds the budget cap.
  // Note: allow SELL (exits) regardless of cap.
  const maxPremiumInr = getMaxPremiumInr();
  if (params.transactionType === 'BUY' && maxPremiumInr != null) {
    const notional = price * params.quantity;
    if (Number.isFinite(notional) && notional > maxPremiumInr) {
      logState('Zerodha exec BUY skipped (budget cap)', {
        exchange: params.exchange,
        tradingsymbol: params.tradingsymbol,
        quantity: params.quantity,
        refLtp: params.refLtp,
        price,
        notional,
        maxPremiumInr,
      });
      return;
    }
  }

  try {
    const res = await fetch(`${baseUrl}/order`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        exchange: params.exchange,
        tradingsymbol: params.tradingsymbol,
        transaction_type: params.transactionType,
        quantity: params.quantity,
        price,
      }),
    });

    const text = await res.text();
    logState('Zerodha exec order response', {
      status: res.status,
      body: text,
      exchange: params.exchange,
      tradingsymbol: params.tradingsymbol,
      transactionType: params.transactionType,
      quantity: params.quantity,
      refLtp: params.refLtp,
      price,
    });
  } catch (e) {
    logState('Zerodha exec order failed', {
      error: String(e),
      exchange: params.exchange,
      tradingsymbol: params.tradingsymbol,
      transactionType: params.transactionType,
      quantity: params.quantity,
      refLtp: params.refLtp,
      price,
    });
  }
}
