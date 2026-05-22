import { Page, Locator } from 'playwright';
import { getBrowserContext, resetContext } from '../../scraper/browser';
import { logger } from '../../logger';
import { saveDebugSnapshot } from '../../utils/debug';

const BANK_ID = 'priorbank';
const BASE_URL = 'https://www.ibank.priorbank.by';

export async function isLoggedIn(page: Page): Promise<boolean> {
  try {
    const url = page.url();
    logger.debug('[priorbank] isLoggedIn check', { url });

    // Any path under /v1/ is the authenticated cabinet area
    if (url.includes('ibank.priorbank.by/v1/')) {
      return true;
    }

    // If login form is visible — not authenticated
    const loginFormVisible = await page
      .locator([
        'input[name="UserName"]',
        'input[name="login"]',
        'input[name="Login"]',
        'input[id="login"]',
        'input[type="text"][autocomplete="username"]',
      ].join(', '))
      .first()
      .isVisible({ timeout: 2_000 })
      .catch(() => false);
    if (loginFormVisible) return false;

    // Check for dashboard elements visible in the authenticated header
    const dashboardVisible = await page
      .locator([
        '.user-name',
        '[class*="user-name"]',
        '[class*="usermenu"]',
        '[class*="user-menu"]',
        'a[href*="logout"]',
        '.logout-link',
      ].join(', '))
      .first()
      .isVisible({ timeout: 2_000 })
      .catch(() => false);
    return dashboardVisible;
  } catch {
    return false;
  }
}

export async function login(): Promise<Page> {
  const bankLogin = process.env.PRIORBANK_LOGIN;
  const bankPassword = process.env.PRIORBANK_PASSWORD;

  if (!bankLogin || !bankPassword) {
    throw new Error('PRIORBANK_LOGIN and PRIORBANK_PASSWORD must be set in environment variables');
  }

  const ctx = await getBrowserContext(BANK_ID);
  const page = await ctx.newPage();

  if (process.env.DEBUG_SCREENSHOTS === 'true') {
    page.on('request', (req) => {
      if (req.method() === 'POST') logger.debug(`[priorbank] → POST ${req.url()}`);
    });
    page.on('response', (res) => {
      if (res.request().method() === 'POST') logger.debug(`[priorbank] ← ${res.status()} ${res.url()}`);
    });
  }

  try {
    // First try the cabinet URL directly — if the session cookie is valid the bank
    // will serve the cabinet without a redirect through the login page.
    logger.debug('[priorbank] Checking for active session on cabinet URL');
    await page.goto(`${BASE_URL}/v1/cabinet/`, { waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => null);
    await page.waitForTimeout(1_500);
    await dismissKendoOverlay(page);

    if (await isLoggedIn(page)) {
      logger.info('[priorbank] Already authenticated (session cookie still valid)', { url: page.url() });
      return page;
    }

    // Session not active — navigate to the login page
    logger.debug('[priorbank] No active session, navigating to login page');
    await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 30_000 }).catch(() =>
      page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 }),
    );
    await page.waitForTimeout(2_000);
    await saveDebugSnapshot(page, 'priorbank-01-login-page');
    logger.debug('[priorbank] Landed on', { url: page.url() });

    // Dismiss any blocking overlay before interacting with the page
    await dismissKendoOverlay(page);
    await page.waitForTimeout(500);

    // Dismiss cookie consent banner if present
    await dismissCookieBanner(page);

    logger.debug('[priorbank] Filling login');
    const loginInput = await waitForInput(page, [
      'input[name="UserName"]',
      'input[name="username"]',
      'input[name="Username"]',
      'input[name="login"]',
      'input[name="Login"]',
      'input[id="login"]',
      'input[autocomplete="username"]',
      // NOTE: input[type="text"] intentionally omitted — too generic, matches search box in cabinet
      'input[type="email"]',
    ]);
    await loginInput.click();
    await loginInput.fill(bankLogin);

    logger.debug('[priorbank] Filling password');
    const passwordInput = await waitForInput(page, [
      'input[name="password"]',
      'input[name="Password"]',
      'input[id="password"]',
      'input[type="password"]',
    ]);
    await passwordInput.click();
    await passwordInput.fill(bankPassword);

    await saveDebugSnapshot(page, 'priorbank-02-fields-filled');

    logger.debug('[priorbank] Clicking submit');
    await clickSubmit(page);

    await saveDebugSnapshot(page, 'priorbank-03-after-submit');

    logger.debug('[priorbank] Waiting for dashboard...');
    // Wait for login form to disappear
    await page.waitForFunction(
      () => {
        const loginInput = (document as Document).querySelector(
          'input[name="UserName"], input[name="login"], input[name="Login"], input[name="username"]',
        );
        return loginInput === null || !(loginInput as HTMLElement).offsetParent;
      },
      { timeout: 30_000, polling: 500 },
    );

    await page.waitForLoadState('networkidle');
    await saveDebugSnapshot(page, 'priorbank-04-logged-in');

    logger.info('[priorbank] Login successful', { url: page.url() });
    return page;
  } catch (err) {
    await saveDebugSnapshot(page, 'priorbank-error-login');
    await page.close().catch(() => null);
    await resetContext(BANK_ID);
    throw new Error(`[priorbank] Login failed: ${(err as Error).message}`);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function waitForInput(page: Page, selectors: string[], timeout = 15_000): Promise<Locator> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    // Search main frame
    for (const sel of selectors) {
      try {
        const loc = page.locator(sel).first();
        if (await loc.isVisible({ timeout: 400 })) return loc;
      } catch { /* try next */ }
    }
    // Search inside iframes
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      for (const sel of selectors) {
        try {
          const loc = frame.locator(sel).first();
          if (await loc.isVisible({ timeout: 400 })) return loc;
        } catch { /* try next */ }
      }
    }
    await page.waitForTimeout(300);
  }
  throw new Error(
    `[priorbank] No visible input found. Tried: ${selectors.join(', ')}. ` +
    'Set DEBUG_SCREENSHOTS=true to capture a snapshot.',
  );
}

async function clickSubmit(page: Page): Promise<void> {
  const candidates = [
    // Priorbank uses a <div> as the submit button
    '[class*="_login_btn"]',
    'div:has-text("Войти"):not(:has(*))',
    'button:has-text("Войти")',
    'button:has-text("Вайсці")',
    'button:has-text("Вход")',
    'button:has-text("Sign in")',
    'button[type="submit"]',
    'input[type="submit"]',
    'button:has-text("Продолжить")',
  ];

  const frames = [page.mainFrame(), ...page.frames().filter((f) => f !== page.mainFrame())];
  for (const frame of frames) {
    for (const sel of candidates) {
      try {
        const btn = frame.locator(sel).first();
        if (await btn.isVisible({ timeout: 600 })) {
          logger.debug(`[priorbank] Clicking: ${sel}`);
          await btn.click();
          return;
        }
      } catch { continue; }
    }
  }

  logger.debug('[priorbank] No submit button found, pressing Enter on password field');
  for (const frame of frames) {
    try {
      const pwInput = frame.locator('input[name="password"], input[name="Password"], input[type="password"]').first();
      if (await pwInput.isVisible({ timeout: 600 })) {
        await pwInput.press('Enter');
        return;
      }
    } catch { continue; }
  }
}

/**
 * Dismiss any visible Kendo UI modal overlay (k-overlay).
 * Priorbank shows a PaymentTimeOver notification popup after login that blocks all clicks.
 * Must be called before interacting with any page element.
 */
export async function dismissKendoOverlay(page: Page): Promise<void> {
  const overlayVisible = await page.locator('.k-overlay').isVisible({ timeout: 2_000 }).catch(() => false);
  if (!overlayVisible) return;

  logger.debug('[priorbank] Kendo overlay detected, dismissing');

  // Try all common close button patterns for Kendo Dialog
  const closeSelectors = [
    '.k-dialog-close',
    '.k-window-titlebar .k-button',
    '.k-dialog .k-button-icon',
    '[aria-label="Закрыть"]',
    '[aria-label="Close"]',
    '[title="Закрыть"]',
    '[title="Close"]',
    '.k-dialog .k-button:last-child',
    '.k-dialog footer .k-button',
    '.k-window-action',
  ];

  for (const sel of closeSelectors) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 800 })) {
        await btn.click({ force: true });   // force=true bypasses the overlay check
        await page.waitForTimeout(500);
        const stillVisible = await page.locator('.k-overlay').isVisible({ timeout: 1_000 }).catch(() => false);
        if (!stillVisible) {
          logger.debug(`[priorbank] Kendo overlay dismissed via: ${sel}`);
          return;
        }
      }
    } catch { /* try next */ }
  }

  // Last resort: press Escape
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
  logger.debug('[priorbank] Kendo overlay dismiss attempted via Escape');
}

async function dismissCookieBanner(page: Page): Promise<void> {
  const candidates = [
    'div:has-text("Всё понятно"):not(:has(*))',
    'button:has-text("Всё понятно")',
    '[class*="_ok_btn"]',
    'button:has-text("Принять")',
    'button:has-text("Accept")',
  ];
  for (const sel of candidates) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 800 })) {
        logger.debug(`[priorbank] Dismissing cookie banner: ${sel}`);
        await btn.click();
        await page.waitForTimeout(500);
        return;
      }
    } catch { /* no banner — that's fine */ }
  }
}

