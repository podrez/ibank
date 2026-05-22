import { Page } from 'playwright';
import { getBrowserContext, resetContext } from '../../scraper/browser';
import { logger } from '../../logger';
import path from 'path';
import fs from 'fs';

const BANK_ID = 'paritetbank';
const BASE_URL = 'https://eparitet.by';
// Vue Router path used for the login page
const SIGN_IN_PATH = '/sign-in';

export async function isLoggedIn(page: Page): Promise<boolean> {
  try {
    const url = page.url();
    logger.debug('[paritetbank] isLoggedIn check', { url });
    return url.includes('eparitet.by') && !url.includes(SIGN_IN_PATH);
  } catch {
    return false;
  }
}

export async function login(): Promise<Page> {
  const bankLogin = process.env.PARITETBANK_LOGIN;
  const bankPassword = process.env.PARITETBANK_PASSWORD;

  if (!bankLogin || !bankPassword) {
    throw new Error('PARITETBANK_LOGIN and PARITETBANK_PASSWORD must be set in environment variables');
  }

  const ctx = await getBrowserContext(BANK_ID);
  const page = await ctx.newPage();

  try {
    logger.info('[paritetbank] Navigating to main page');
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });

    // Vue SPA needs time to hydrate and run the router guard
    await page.waitForTimeout(3_000);
    await saveDebugSnapshot(page, 'paritetbank-01-initial');

    if (await isLoggedIn(page)) {
      logger.info('[paritetbank] Already authenticated (session cookie valid)', { url: page.url() });
      return page;
    }

    // Wait for the login form to render inside the Vue app
    logger.info('[paritetbank] Waiting for login form...');
    await page.waitForSelector('input[autocomplete="login"], .login input[type="text"]', {
      timeout: 20_000,
    });
    await saveDebugSnapshot(page, 'paritetbank-02-form');

    logger.info('[paritetbank] Filling login');
    const loginInput = page.locator('input[autocomplete="login"]').first();
    await loginInput.click();
    await loginInput.fill(bankLogin);

    logger.info('[paritetbank] Filling password');
    const passwordInput = page.locator('input[type="password"]').first();
    await passwordInput.click();
    await passwordInput.fill(bankPassword);

    await saveDebugSnapshot(page, 'paritetbank-03-filled');

    logger.info('[paritetbank] Submitting');
    await page.locator('button[type="submit"]').first().click();

    // Wait for Vue Router to navigate away from /sign-in
    logger.info('[paritetbank] Waiting for post-login navigation...');
    await page.waitForFunction(
      () => !window.location.href.includes('/sign-in'),
      { timeout: 30_000, polling: 500 },
    );

    // Handle multi-organisation selection page
    if (page.url().includes('/select-organizations')) {
      logger.info('[paritetbank] Organization selection page — picking organisation');
      await handleOrgSelection(page);
    }

    await page.waitForLoadState('networkidle').catch(() => null);
    await saveDebugSnapshot(page, 'paritetbank-04-logged-in');

    logger.info('[paritetbank] Login successful', { url: page.url() });
    return page;
  } catch (err) {
    await saveDebugSnapshot(page, 'paritetbank-error-login');
    await page.close().catch(() => null);
    await resetContext(BANK_ID);
    throw new Error(`[paritetbank] Login failed: ${(err as Error).message}`);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function handleOrgSelection(page: Page): Promise<void> {
  const preferredOrg = process.env.PARITETBANK_ORG?.trim();

  // Try to click the preferred org by name, or fall back to the first item
  const clicked = await page.evaluate((orgName: string | undefined) => {
    const items = Array.from(document.querySelectorAll(
      '.organizations-list__item, [data-org-item], .org-list__item, li[class*="org"]',
    ));
    if (items.length === 0) return false;
    const target = orgName
      ? items.find((el) => el.textContent?.includes(orgName)) ?? items[0]
      : items[0];
    (target as HTMLElement).click();
    return true;
  }, preferredOrg);

  if (!clicked) {
    // Fallback: click the first visible button/link on the page that isn't a nav
    await page.locator('button[class*="org"], button[class*="select"]').first().click().catch(() => null);
  }

  await page.waitForFunction(
    () => !window.location.href.includes('/select-organizations'),
    { timeout: 20_000, polling: 500 },
  ).catch(() => null);

  logger.info('[paritetbank] Organisation selected', { url: page.url() });
}

async function saveDebugSnapshot(page: Page, name: string): Promise<void> {
  if (process.env.DEBUG_SCREENSHOTS !== 'true') return;
  const dir = './data/debug';
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `${name}.png`), fullPage: true }).catch(() => null);
  await page.content().then((html) =>
    fs.writeFileSync(path.join(dir, `${name}.html`), html),
  ).catch(() => null);
}
