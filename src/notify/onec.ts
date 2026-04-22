import { logger } from '../logger';

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
    const res = await fetch(url, {
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
