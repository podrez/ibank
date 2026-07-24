import { Page } from 'playwright';

/**
 * Shared helpers for the iParitet (physical-person) JSON API.
 *
 * iParitet (https://iparitet.by) is an Angular SPA that authenticates with a
 * bearer token kept in localStorage (ngxs `auth.sessionToken`) and sent as
 * `Authorization: Bearer <token>` on every API call. We reuse that token to
 * call the same JSON endpoints the app uses, instead of scraping the DOM.
 */

export const ORIGIN = 'https://iparitet.by';
/** Core API base (products, balances, operation history). */
export const CORE_API = '/core/services/v3';

/** ISO-4217 numeric → alphabetic currency code (the API returns numeric codes). */
const CURRENCY_BY_ISO: Record<string, string> = {
  '933': 'BYN',
  '643': 'RUB',
  '840': 'USD',
  '978': 'EUR',
  '826': 'GBP',
  '985': 'PLN',
  '156': 'CNY',
  '784': 'AED',
};

/** Normalise a currency value that may already be alphabetic or a numeric ISO code. */
export function normaliseCurrency(raw: unknown): string {
  const s = String(raw ?? '').trim();
  if (!s) return 'BYN';
  return CURRENCY_BY_ISO[s] ?? s.toUpperCase();
}

/**
 * Read the bearer session token the SPA keeps under `auth.sessionToken`
 * (value is a JSON-encoded string). It lives in **sessionStorage** (verified
 * against a live login), so check that first; fall back to localStorage and to a
 * key-suffix match in case a future build changes the store or adds a namespace.
 */
export async function readSessionToken(page: Page): Promise<string | null> {
  const raw = await page.evaluate(() => {
    const pick = (v: string | null): string | null => {
      if (!v) return null;
      try { return JSON.parse(v) as string; } catch { return v; }
    };
    for (const store of [sessionStorage, localStorage]) {
      const direct = store.getItem('auth.sessionToken');
      if (direct) return pick(direct);
    }
    for (const store of [sessionStorage, localStorage]) {
      for (let i = 0; i < store.length; i++) {
        const k = store.key(i);
        if (k && k.endsWith('sessionToken')) return pick(store.getItem(k));
      }
    }
    return null;
  }).catch(() => null);

  // The SPA writes the literal string "undefined" into these slots before login
  // completes — treat that (and anything too short to be a JWT) as "no token".
  if (!raw || raw === 'undefined' || raw === 'null' || raw.length < 20) return null;
  return raw;
}

/**
 * Bearer tokens sniffed from the SPA's own API traffic, per page.
 *
 * sessionStorage is not a dependable source: the token lands there only after
 * ngxs flushes it, and in production it intermittently never showed up at all
 * within the wait window. The app itself, however, always attaches
 * `Authorization: Bearer …` to its `/services/v3` calls — capturing that header
 * yields exactly the token the app is using, whatever the store is doing.
 */
const capturedTokens = new WeakMap<Page, string>();

/** Start recording bearer tokens from the page's API requests. Call once, before navigating. */
export function attachTokenCapture(page: Page): void {
  if (capturedTokens.has(page)) return;
  page.on('request', (req) => {
    try {
      if (!req.url().includes('/services/v3')) return;
      const auth = req.headers()['authorization'];
      if (!auth) return;
      const token = auth.replace(/^Bearer\s+/i, '').trim();
      if (token.length >= 20) capturedTokens.set(page, token);
    } catch { /* header access can throw on aborted requests */ }
  });
}

/**
 * Resolve the bearer token, polling until one is available: prefer what the app
 * last sent on the wire, then fall back to sessionStorage/localStorage.
 */
export async function waitForSessionToken(page: Page, timeoutMs = 15_000): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const captured = capturedTokens.get(page);
    if (captured) return captured;
    const stored = await readSessionToken(page);
    if (stored) return stored;
    if (Date.now() >= deadline) return null;
    await page.waitForTimeout(500);
  }
}

interface ApiCallParams {
  path: string;
  method: 'GET' | 'POST';
  token: string;
  body?: unknown;
}

export interface ApiResult {
  ok: boolean;
  status: number;
  data: unknown;
  /** Set when the call failed or the body could not be parsed as JSON. */
  error?: string;
}

/**
 * Call an iParitet JSON API endpoint from within the page context (same-origin),
 * attaching the bearer token exactly as the app's HTTP interceptor does.
 * Never throws inside the page.
 *
 * A 200 whose body isn't JSON counts as a failure (`ok: false`) — the bank
 * occasionally answers that way, and treating it as success made it look like
 * the customer simply had no accounts.
 */
export async function apiCall(page: Page, params: ApiCallParams): Promise<ApiResult> {
  return page.evaluate(async (p: ApiCallParams) => {
    try {
      const res = await fetch(p.path, {
        method: p.method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${p.token}`,
        },
        body: p.method === 'POST' ? JSON.stringify(p.body ?? {}) : undefined,
        credentials: 'same-origin',
      });
      const text = await res.text().catch(() => '');
      if (!res.ok) {
        return { ok: false, status: res.status, data: null, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
      }
      try {
        return { ok: true, status: res.status, data: JSON.parse(text) };
      } catch {
        return {
          ok: false,
          status: res.status,
          data: null,
          error: `HTTP ${res.status} with non-JSON body (${text.length} chars): ${text.slice(0, 200)}`,
        };
      }
    } catch (err) {
      return { ok: false, status: 0, data: null, error: `request failed: ${String(err)}` };
    }
  }, params);
}

/** Run an API call, retrying once after a short delay — the bank has transient blips. */
export async function apiCallWithRetry(page: Page, params: ApiCallParams): Promise<ApiResult> {
  const first = await apiCall(page, params);
  if (first.ok) return first;
  await page.waitForTimeout(2_000);
  return apiCall(page, params);
}

/** Belarus is permanently UTC+3 (no DST) — build the day-boundary ms timestamps the API expects. */
export function minskDayStartMs(isoDate: string): number {
  return Date.parse(`${isoDate}T00:00:00+03:00`);
}

export function minskDayEndMs(isoDate: string): number {
  return Date.parse(`${isoDate}T23:59:59.999+03:00`);
}
