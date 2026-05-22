import { Page, Locator } from 'playwright';
import { getBrowserContext, resetContext } from '../../scraper/browser';
import { logger } from '../../logger';
import path from 'path';
import fs from 'fs';

const BANK_ID = 'belveb';
const BASE_URL = 'https://dbo2.bveb.by';
// URL that the bank redirects to after successful login
const CABINET_URL_PATTERN = '/Cabinet/';

export async function isLoggedIn(page: Page): Promise<boolean> {
  try {
    const url = page.url();
    logger.debug('[belveb] isLoggedIn check', { url });
    // Authenticated area is always under /Cabinet/
    return url.includes(CABINET_URL_PATTERN);
  } catch {
    return false;
  }
}

export async function login(): Promise<Page> {
  const bankLogin = process.env.BELVEB_LOGIN;
  const bankPassword = process.env.BELVEB_PASSWORD;

  if (!bankLogin || !bankPassword) {
    throw new Error('BELVEB_LOGIN and BELVEB_PASSWORD must be set in environment variables');
  }

  const ctx = await getBrowserContext(BANK_ID);
  const page = await ctx.newPage();

  if (process.env.DEBUG_SCREENSHOTS === 'true') {
    page.on('request', (req) => {
      if (req.method() === 'POST') logger.debug(`[belveb] → POST ${req.url()}`);
    });
    page.on('response', (res) => {
      if (res.request().method() === 'POST') logger.debug(`[belveb] ← ${res.status()} ${res.url()}`);
    });
  }

  try {
    // Navigate to main page — if session cookie is still valid the bank
    // will redirect straight to /Cabinet/.
    logger.info('[belveb] Navigating to main page');
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForTimeout(2_000);
    await saveDebugSnapshot(page, 'belveb-01-initial');

    if (await isLoggedIn(page)) {
      logger.info('[belveb] Already authenticated (session cookie still valid)', { url: page.url() });
      return page;
    }

    // The login form is loaded via AJAX into #fmLogin only after the user
    // clicks the "Войти" link (carousel slide 1). Click it first.
    logger.info('[belveb] Clicking "Войти" to open login slide');
    const loginSlideLink = await findLoginSlideLink(page);
    if (loginSlideLink) {
      await loginSlideLink.click();
    } else {
      // Direct link may work even without clicking the slide button
      logger.debug('[belveb] Войти link not found, trying direct portlet navigation');
      await page.evaluate(() => {
        // Try Bootstrap carousel API
        const $ = (window as unknown as { $: (sel: string) => { carousel: (n: number) => void } }).$;
        if ($) $('#carousel').carousel(1);
      });
    }

    // Wait for the login form portlet to load inside #fmLogin
    logger.info('[belveb] Waiting for login form to load in #fmLogin...');
    await page.waitForFunction(
      () => {
        const fmLogin = document.querySelector('#fmLogin');
        if (!fmLogin) return false;
        return fmLogin.querySelector('input') !== null;
      },
      { timeout: 20_000, polling: 300 },
    );

    // The login portlet has two tabs: "Вход по паролю" and "Вход по ЭЦП".
    // Make sure we are on the password tab before filling credentials.
    logger.info('[belveb] Switching to "Вход по паролю" tab');
    const passwordTabCandidates = [
      '#fmLogin a:has-text("Вход по паролю")',
      '#fmLogin a:has-text("по паролю")',
      '#fmLogin [data-toggle="tab"]:has-text("паролю")',
      '#fmLogin li:has-text("паролю") a',
      'a:has-text("Вход по паролю")',
      'a:has-text("по паролю")',
      '[data-toggle="tab"]:has-text("паролю")',
    ];
    for (const sel of passwordTabCandidates) {
      try {
        const tab = page.locator(sel).first();
        if (await tab.isVisible({ timeout: 500 })) {
          await tab.click();
          await page.waitForTimeout(400);
          logger.debug(`[belveb] Password tab clicked: ${sel}`);
          break;
        }
      } catch { /* try next */ }
    }
    await saveDebugSnapshot(page, 'belveb-02-form-loaded');

    logger.info('[belveb] Filling username');
    const loginInput = await waitForInputInContainer(page, '#fmLogin', [
      'input[name="UserName"]',
      'input[name="username"]',
      'input[name="Username"]',
      'input[name="login"]',
      'input[name="Login"]',
      'input[id="username"]',
      'input[autocomplete="username"]',
      'input[type="text"]',
    ]);
    await loginInput.click();
    await loginInput.fill(bankLogin);

    logger.info('[belveb] Filling password');
    const passwordInput = await waitForInputInContainer(page, '#fmLogin', [
      'input[name="Password"]',
      'input[name="password"]',
      'input[id="password"]',
      'input[type="password"]',
    ]);
    await passwordInput.click();
    await passwordInput.fill(bankPassword);

    await saveDebugSnapshot(page, 'belveb-03-fields-filled');

    logger.info('[belveb] Clicking submit');
    await clickSubmit(page);

    await saveDebugSnapshot(page, 'belveb-04-after-submit');

    logger.info('[belveb] Waiting for cabinet...');
    await page.waitForURL(`**${CABINET_URL_PATTERN}**`, { timeout: 30_000 });

    await page.waitForLoadState('networkidle').catch(() => null);
    await saveDebugSnapshot(page, 'belveb-05-logged-in');

    logger.info('[belveb] Login successful', { url: page.url() });
    return page;
  } catch (err) {
    await saveDebugSnapshot(page, 'belveb-error-login');
    await page.close().catch(() => null);
    await resetContext(BANK_ID);
    throw new Error(`[belveb] Login failed: ${(err as Error).message}`);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function findLoginSlideLink(page: Page): Promise<Locator | null> {
  const candidates = [
    // Bootstrap carousel "go to slide 1" link
    'a[data-slide-to="1"][href="#carousel"]',
    // Text-based
    'a:has-text("Вход"):not([href*="loginForm"])',
    'a:has-text("Войти"):not(.btn-register)',
    // The carousel button that has p>Войти inside
    '.btn-register:has(p:text("Войти"))',
    '[href="#carousel"][data-slide-to="1"]',
  ];
  for (const sel of candidates) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 600 })) return el;
    } catch { /* try next */ }
  }
  return null;
}

async function waitForInputInContainer(
  page: Page,
  container: string,
  selectors: string[],
  timeout = 10_000,
): Promise<Locator> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const sel of selectors) {
      try {
        const loc = page.locator(`${container} ${sel}`).first();
        if (await loc.isVisible({ timeout: 400 })) return loc;
      } catch { /* try next */ }
    }
    // Also check iframes
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
    `[belveb] No visible input found in ${container}. Tried: ${selectors.join(', ')}. ` +
    'Set DEBUG_SCREENSHOTS=true to capture a snapshot.',
  );
}

async function clickSubmit(page: Page): Promise<void> {
  const candidates = [
    // BIA platform standard submit button inside the login portlet
    '#fmLogin button[type="submit"]',
    '#fmLogin input[type="submit"]',
    '#fmLogin button:has-text("Войти")',
    '#fmLogin button:has-text("Вход")',
    // Generic fallbacks
    'button[type="submit"]',
    'input[type="submit"]',
    'button:has-text("Войти")',
    'button:has-text("Вход")',
    'button:has-text("Sign in")',
    'button:has-text("Продолжить")',
  ];

  for (const sel of candidates) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 600 })) {
        logger.debug(`[belveb] Clicking: ${sel}`);
        await btn.click();
        return;
      }
    } catch { continue; }
  }

  logger.debug('[belveb] No submit button found, pressing Enter on password field');
  await page.locator('#fmLogin input[type="password"], input[type="password"]').first().press('Enter');
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
