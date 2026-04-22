import { Page, Locator } from 'playwright';
import { getBrowserContext, resetContext } from '../../scraper/browser';
import { logger } from '../../logger';
import path from 'path';
import fs from 'fs';

const BANK_ID = 'alfabank';
const BASE_URL = 'https://online.alfabank.by';
const CHECK_USER_URL = `${BASE_URL}/Bia.Portlets.Ib.Alfa.Membership.Login/Login/CheckCurrentUser`;

export async function isLoggedIn(page: Page): Promise<boolean> {
  try {
    const loginFormVisible = await page
      .locator('input[name="Password"]')
      .isVisible({ timeout: 2000 })
      .catch(() => false);
    if (loginFormVisible) return false;

    const response = await page.request
      .post(CHECK_USER_URL, { headers: { 'X-Requested-With': 'XMLHttpRequest' } })
      .catch(() => null);
    if (response?.ok()) {
      const body = await response.json().catch(() => null);
      if (body?.IsAuthorized === false || body?.isAuthorized === false) return false;
    }

    return true;
  } catch {
    return false;
  }
}

export async function login(): Promise<Page> {
  const bankLogin = process.env.ALFABANK_LOGIN ?? process.env.BANK_LOGIN;
  const bankPassword = process.env.ALFABANK_PASSWORD ?? process.env.BANK_PASSWORD;

  if (!bankLogin || !bankPassword) {
    throw new Error('ALFABANK_LOGIN and ALFABANK_PASSWORD must be set in environment variables');
  }

  const ctx = await getBrowserContext(BANK_ID);
  const page = await ctx.newPage();

  if (process.env.DEBUG_SCREENSHOTS === 'true') {
    page.on('request', (req) => {
      if (req.method() === 'POST') logger.debug(`[alfabank] → POST ${req.url()}`);
    });
    page.on('response', (res) => {
      if (res.request().method() === 'POST') logger.debug(`[alfabank] ← ${res.status()} ${res.url()}`);
    });
  }

  try {
    logger.info('[alfabank] Navigating to Alfa-Bank');
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    await saveDebugSnapshot(page, 'alfabank-01-login-page');

    const loginFormVisible = await page
      .locator('input[name="Password"]')
      .isVisible({ timeout: 2000 })
      .catch(() => false);
    if (!loginFormVisible) {
      logger.info('[alfabank] Already authenticated (session cookie still valid)');
      return page;
    }

    logger.info('[alfabank] Filling username');
    const usernameInput = await waitForInput(page, [
      'input[name="UserName"]',
      'input[autocomplete="username"]',
      'form input[type="text"]',
    ]);
    await usernameInput.click();
    await usernameInput.fill(bankLogin);

    logger.info('[alfabank] Filling password');
    const passwordInput = await waitForInput(page, [
      'input[name="Password"]',
      'input[type="password"]',
    ]);
    await passwordInput.click();
    await passwordInput.fill(bankPassword);

    await saveDebugSnapshot(page, 'alfabank-02-fields-filled');

    logger.info('[alfabank] Clicking submit');
    await clickSubmit(page);

    await saveDebugSnapshot(page, 'alfabank-03-after-submit');

    logger.info('[alfabank] Waiting for dashboard...');
    await page.waitForFunction(
      () => (document as Document).querySelector('input[name="Password"]') === null,
      { timeout: 30_000, polling: 500 },
    );

    await page.waitForLoadState('networkidle');
    await saveDebugSnapshot(page, 'alfabank-04-logged-in');

    logger.info('[alfabank] Login successful', { url: page.url() });
    return page;
  } catch (err) {
    await saveDebugSnapshot(page, 'alfabank-error-login');
    await page.close().catch(() => null);
    await resetContext(BANK_ID);
    throw new Error(`[alfabank] Login failed: ${(err as Error).message}`);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function waitForInput(page: Page, selectors: string[], timeout = 10_000): Promise<Locator> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const sel of selectors) {
      try {
        const loc = page.locator(sel).first();
        if (await loc.isVisible({ timeout: 400 })) return loc;
      } catch { /* try next */ }
    }
    await page.waitForTimeout(300);
  }
  throw new Error(
    `[alfabank] No visible input found. Tried: ${selectors.join(', ')}. ` +
    'Set DEBUG_SCREENSHOTS=true to capture a snapshot.',
  );
}

async function clickSubmit(page: Page): Promise<void> {
  const candidates = [
    'button:has-text("Войти")',
    'button[type="submit"]',
    'input[type="submit"]',
    'button:has-text("Продолжить")',
  ];

  for (const sel of candidates) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 600 })) {
        logger.debug(`[alfabank] Clicking: ${sel}`);
        await btn.click();
        return;
      }
    } catch { continue; }
  }

  logger.debug('[alfabank] No submit button found, pressing Enter on password field');
  await page.locator('input[name="Password"], input[type="password"]').first().press('Enter');
}

async function saveDebugSnapshot(page: Page, name: string): Promise<void> {
  if (process.env.DEBUG_SCREENSHOTS !== 'true') return;
  const dir = './data/debug';
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `${name}.png`), fullPage: true }).catch(() => null);
}
