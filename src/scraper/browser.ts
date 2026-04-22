import { chromium, Browser, BrowserContext } from 'playwright';
import { logger } from '../logger';

let browser: Browser | null = null;
const contexts = new Map<string, BrowserContext>();

const TIMEOUT = parseInt(process.env.BROWSER_TIMEOUT_MS ?? '30000');
const HEADLESS = process.env.HEADLESS !== 'false';

async function ensureBrowser(): Promise<Browser> {
  if (!browser || !browser.isConnected()) {
    logger.info('Launching Chromium browser');
    browser = await chromium.launch({
      headless: HEADLESS,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
      ],
    });
  }
  return browser;
}

export async function getBrowserContext(bankId: string): Promise<BrowserContext> {
  const b = await ensureBrowser();

  if (!contexts.has(bankId)) {
    const ctx = await b.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      viewport: { width: 1366, height: 768 },
      locale: 'ru-RU',
      timezoneId: 'Europe/Minsk',
    });
    ctx.setDefaultTimeout(TIMEOUT);
    contexts.set(bankId, ctx);
    logger.debug(`Browser context created for bank: ${bankId}`);
  }

  return contexts.get(bankId)!;
}

export async function resetContext(bankId: string): Promise<void> {
  const ctx = contexts.get(bankId);
  if (ctx) {
    await ctx.close().catch(() => null);
    contexts.delete(bankId);
    logger.debug(`Browser context reset for bank: ${bankId}`);
  }
}

export async function closeBrowser(): Promise<void> {
  for (const [bankId, ctx] of contexts) {
    await ctx.close().catch(() => null);
    logger.debug(`Browser context closed for bank: ${bankId}`);
  }
  contexts.clear();

  if (browser) {
    await browser.close().catch(() => null);
    browser = null;
    logger.info('Browser closed');
  }
}
