import { chromium, Browser, BrowserContext } from 'playwright';
import { logger } from '../logger';
import { getConfig } from '../config/store';

let browser: Browser | null = null;
const contexts = new Map<string, BrowserContext>();
let launchPromise: Promise<Browser> | null = null;

function getTimeout(): number {
  return parseInt(getConfig('BROWSER_TIMEOUT_MS') ?? '') || 30_000;
}

function isHeadless(): boolean {
  return getConfig('HEADLESS') !== 'false';
}

async function ensureBrowser(): Promise<Browser> {
  if (browser?.isConnected()) return browser;

  // Serialize concurrent launch attempts — return the in-flight promise if one exists
  if (launchPromise) return launchPromise;

  launchPromise = (async () => {
    // Clear stale contexts tied to the dead browser before relaunching
    for (const [, ctx] of contexts) {
      await ctx.close().catch(() => null);
    }
    contexts.clear();

    const executablePath = getConfig('CHROMIUM_EXECUTABLE_PATH') || undefined;
    if (executablePath) logger.info(`Using custom Chromium executable: ${executablePath}`);
    logger.info('Launching Chromium browser');
    const b = await chromium.launch({
      headless: isHeadless(),
      executablePath,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
      ],
    });
    browser = b;
    return b;
  })().finally(() => {
    launchPromise = null;
  });

  return launchPromise;
}

export async function getBrowserContext(bankId: string): Promise<BrowserContext> {
  const b = await ensureBrowser();

  if (!contexts.has(bankId)) {
    const ctx = await b.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      viewport: { width: 1366, height: 768 },
      locale: 'ru-RU',
      timezoneId: getConfig('APP_TIMEZONE') ?? 'Europe/Minsk',
    });
    ctx.setDefaultTimeout(getTimeout());
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

/** Close browser if running, so next sync re-launches with fresh settings. */
export async function closeBrowserIfOpen(): Promise<void> {
  if (browser?.isConnected()) {
    await closeBrowser();
  }
}
