import { logger } from '../logger';

const MAX_ATTEMPTS = 3;

async function fetchWithRetry(
  url: string,
  options: RequestInit,
): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, options);
      // Retry on server errors; surface 4xx immediately (auth/config issue, not transient)
      if (res.status >= 500 && attempt < MAX_ATTEMPTS) {
        logger.debug(`1C webhook attempt ${attempt} got ${res.status}, retrying`);
        await new Promise((r) => setTimeout(r, 500 * 2 ** (attempt - 1)));
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_ATTEMPTS) {
        logger.debug(`1C webhook attempt ${attempt} network error, retrying`, { error: (err as Error).message });
        await new Promise((r) => setTimeout(r, 500 * 2 ** (attempt - 1)));
      }
    }
  }
  throw lastErr;
}

/**
 * Notify 1C that new statement transactions were imported for an account.
 * Configured via ONEC_WEBHOOK_URL, ONEC_USERNAME, ONEC_PASSWORD, ONEC_API_KEY.
 * Silently skips if ONEC_WEBHOOK_URL is not set.
 */
export async function notifyStatementChanged(bank: string, accountNumber: string): Promise<void> {
  const url = process.env.ONEC_WEBHOOK_URL;
  if (!url) return;

  const username = process.env.ONEC_USERNAME ?? '';
  const password = process.env.ONEC_PASSWORD ?? '';
  const apiKey   = process.env.ONEC_API_KEY ?? '';

  const basicToken = Buffer.from(`${username}:${password}`).toString('base64');

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Authorization': `Basic ${basicToken}`,
  };
  if (apiKey) {
    headers['X-Api-Key'] = apiKey;
  }

  try {
    const res = await fetchWithRetry(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ bank, account: accountNumber }),
    });

    if (!res.ok) {
      logger.warn('1C notification returned non-OK status', {
        bank,
        account: accountNumber,
        status: res.status,
      });
    } else {
      logger.debug('1C notification sent', { bank, account: accountNumber, status: res.status });
    }
  } catch (err) {
    logger.warn('1C notification failed', {
      bank,
      account: accountNumber,
      error: (err as Error).message,
    });
  }
}
