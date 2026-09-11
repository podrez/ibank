import { Page } from 'playwright';
import { getBrowserContext, resetContext } from '../../scraper/browser';
import { logger } from '../../logger';
import { saveDebugSnapshot } from '../../utils/debug';
import { getConfig } from '../../config/store';

const BANK_ID = 'paritetbank';
// The account lives on the bank's "new IT architecture" host. Signing in on the old
// https://eparitet.by still works but redirects here and needs a second sign-in
// (see waitForPostLogin).
const BASE_URL = 'https://new.eparitet.by';
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
  const bankLogin = getConfig('PARITETBANK_LOGIN');
  const bankPassword = getConfig('PARITETBANK_PASSWORD');

  if (!bankLogin || !bankPassword) {
    throw new Error('PARITETBANK_LOGIN and PARITETBANK_PASSWORD must be set');
  }

  const ctx = await getBrowserContext(BANK_ID);
  const page = await ctx.newPage();

  try {
    logger.debug('[paritetbank] Navigating to main page');
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });

    // Vue SPA needs time to hydrate and run the router guard
    await page.waitForTimeout(3_000);
    await saveDebugSnapshot(page, 'paritetbank-01-initial');

    if (await isLoggedIn(page)) {
      logger.info('[paritetbank] Already authenticated (session cookie valid)', { url: page.url() });
      return page;
    }

    await submitCredentials(page, bankLogin, bankPassword);

    // Wait for Vue Router to navigate away from /sign-in
    logger.debug('[paritetbank] Waiting for post-login navigation...');
    await waitForPostLogin(page, bankLogin, bankPassword);

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

const LOGIN_INPUT = 'input[autocomplete="login"]';

async function submitCredentials(page: Page, bankLogin: string, bankPassword: string): Promise<void> {
  // Wait for the login form to render inside the Vue app
  logger.debug('[paritetbank] Waiting for login form...', { url: page.url() });
  await page.waitForSelector(`${LOGIN_INPUT}, .login input[type="text"]`, { timeout: 20_000 });
  await saveDebugSnapshot(page, 'paritetbank-02-form');

  logger.debug('[paritetbank] Filling login');
  const loginInput = page.locator(LOGIN_INPUT).first();
  await loginInput.click();
  await loginInput.fill(bankLogin);

  logger.debug('[paritetbank] Filling password');
  const passwordInput = page.locator('input[type="password"]').first();
  await passwordInput.click();
  await passwordInput.fill(bankPassword);

  await saveDebugSnapshot(page, 'paritetbank-03-filled');

  logger.debug('[paritetbank] Submitting login form');
  await page.locator('button[type="submit"]').first().click();
}

// Safety net for a host that redirects elsewhere: since 09.2026 signing in on the old
// eparitet.by returns `redirectUri: https://new.eparitet.by/` from auth/signin, and the
// SPA shows a notice whose «Перейти» button moves to that host — which keeps its own
// session and asks for the credentials again. BASE_URL now points at the new host
// directly, so this only kicks in if the bank starts redirecting again.
const NOTICE_BUTTON = '.signin-ms-modal__button';

async function waitForPostLogin(
  page: Page,
  bankLogin: string,
  bankPassword: string,
  timeoutMs = 45_000,
): Promise<void> {
  const signedInOn = new Set([new URL(page.url()).host]);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!page.url().includes(SIGN_IN_PATH)) return;

    const host = new URL(page.url()).host;
    const notice = page.locator(NOTICE_BUTTON).first();
    if (await notice.isVisible().catch(() => false)) {
      logger.info('[paritetbank] Dismissing migration notice («Перейти»)');
      await notice.click().catch(() => null);
    } else if (!signedInOn.has(host) && await page.locator(LOGIN_INPUT).first().isVisible().catch(() => false)) {
      logger.info('[paritetbank] Redirected to another host — signing in there', { host });
      signedInOn.add(host);
      await submitCredentials(page, bankLogin, bankPassword);
    }

    await page.waitForTimeout(500);
  }
  throw new Error(`still on ${page.url()} after ${timeoutMs / 1000}s`);
}

async function handleOrgSelection(page: Page): Promise<void> {
  const preferredOrg = getConfig('PARITETBANK_ORG')?.trim();

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

