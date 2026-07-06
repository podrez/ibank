import { chromium, Browser, BrowserContext } from 'playwright';
import fs from 'fs';
import path from 'path';
import { logger } from '../logger';
import { getConfig } from '../config/store';

let browser: Browser | null = null;
const contexts = new Map<string, BrowserContext>();
let launchPromise: Promise<Browser> | null = null;

// Persisted session (cookies + localStorage) per bank, so a login that required
// SMS confirmation survives process restarts and does not need to be repeated.
const SESSION_DIR = process.env.SESSION_DIR ?? './data/sessions';

function sessionPath(bankId: string): string {
  return path.join(SESSION_DIR, `${bankId}.json`);
}

export function hasSavedSession(bankId: string): boolean {
  return fs.existsSync(sessionPath(bankId));
}

/** Persist the current cookies/localStorage of a bank's context to disk. */
export async function saveSession(bankId: string): Promise<void> {
  const ctx = contexts.get(bankId);
  if (!ctx) return;
  try {
    if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });
    await ctx.storageState({ path: sessionPath(bankId) });
    logger.info(`Session persisted for bank: ${bankId}`);
  } catch (err) {
    logger.warn(`Failed to persist session for ${bankId}: ${(err as Error).message}`);
  }
}

/** Forget a bank's saved session and drop its live context. */
export async function clearSession(bankId: string): Promise<void> {
  try {
    if (fs.existsSync(sessionPath(bankId))) fs.rmSync(sessionPath(bankId));
  } catch { /* ignore */ }
  await resetContext(bankId);
  logger.info(`Session cleared for bank: ${bankId}`);
}

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
    const storagePath = sessionPath(bankId);
    const storageState = fs.existsSync(storagePath) ? storagePath : undefined;
    if (storageState) logger.debug(`Restoring saved session for bank: ${bankId}`);
    const ctx = await b.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      viewport: { width: 1366, height: 768 },
      locale: 'ru-RU',
      timezoneId: getConfig('APP_TIMEZONE') ?? 'Europe/Minsk',
      storageState,
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
