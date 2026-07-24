import { Page, Locator } from 'playwright';
import { getBrowserContext, saveSession } from '../../scraper/browser';
import { logger } from '../../logger';
import { saveDebugSnapshot } from '../../utils/debug';
import { getConfig } from '../../config/store';
import { waitForSessionToken, attachTokenCapture } from './api';
import {
  registerInteractiveAuth,
  ReauthRequiredError,
  isReauthRequired,
  AuthStartResult,
  AuthStage,
} from '../../auth/interactive';

const BANK_ID = 'iparitet';
const BASE_URL = 'https://iparitet.by';

// Best-effort selectors — iParitet is an Angular SPA rendering custom form
// components, so the exact markup isn't knowable without a live snapshot. These
// cast a wide net; calibrate against ./data/debug/iparitet-sms-*.html (page shape
// is also dumped to the log) if the flow stalls.
// iParitet wraps fields in an <app-text-input> whose inner <input> carries the
// class `app-control-field__input` and binds the reactive control via
// [formControl] (so there is NO `formcontrolname` attribute in the DOM, and the
// text field may have no explicit `type` attribute — hence class-based matching).
const LOGIN_INPUT_SELECTORS = [
  'input.app-control-field__input:not([type="password"])',
  'input[formcontrolname="login"]',
  'input[name="login"]',
  'input[autocomplete="username"]',
  'input[type="text"]',
  'input[type="tel"]',
];
const PASSWORD_INPUT_SELECTORS = [
  'input.app-control-field__input[type="password"]',
  'input[type="password"]',
  'input[formcontrolname="password"]',
];
const SUBMIT_SELECTORS = [
  'button:has-text("Войти")',
  'button:has-text("Продолжить")',
  'button[type="submit"]',
];
// SMS code inputs — must be SPECIFIC: the generic `.app-control-field__input`
// class is shared with the login/password fields, so using it here would
// falsely report "awaiting SMS" the instant the login form renders. Detection
// relies on these plus the `/registration/code` route.
const SMS_INPUT_SELECTORS = [
  'input[autocomplete="one-time-code"]',
  'input[formcontrolname="code"]',
  'input[name="code"]',
  'input.app-control-field__input[maxlength="1"]',
  'input[maxlength="1"]',
];
// The dedicated route the SPA navigates to for the SMS one-time code.
const SMS_CODE_ROUTE = '/registration/code';
const SMS_CONFIRM_SELECTORS = [
  'button:has-text("Подтвердить")',
  'button:has-text("Продолжить")',
  'button:has-text("Войти")',
  'button[type="submit"]',
];

/**
 * Logged in when the SPA has routed into its authenticated `/app` section — its
 * own router guard bounces unauthenticated users back to `/auth/...`, so the
 * route is the reliable signal.
 *
 * Deliberately does NOT require the bearer token: the dashboard route is reached
 * a moment before ngxs flushes the token into sessionStorage, and gating on it
 * here made login appear to never complete. Code that actually needs the token
 * waits for it via `waitForSessionToken`.
 */
export async function isLoggedIn(page: Page): Promise<boolean> {
  try {
    if (page.isClosed()) return false;
    const url = page.url();
    return url.includes('iparitet.by') && url.includes('/app') && !url.includes('/auth');
  } catch {
    return false;
  }
}

/**
 * Automated (scheduler) login.
 *
 * A normal login/password sign-in does NOT require an SMS on this account, so the
 * scheduler can authenticate on its own: it reuses the persisted session and, if
 * that is gone, submits credentials and waits for the dashboard. Only if the bank
 * genuinely holds on the SMS code page (a new-device challenge) does it throw
 * {@link ReauthRequiredError} so an operator completes the SMS once via the
 * settings UI — deliberately not retried, so no SMS is fired every cycle.
 */
export async function login(): Promise<Page> {
  const ctx = await getBrowserContext(BANK_ID);
  const page = await ctx.newPage();
  attachTokenCapture(page);

  try {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    // Angular router runs its auth guard after hydration.
    await page.waitForTimeout(3000);
    await saveDebugSnapshot(page, 'iparitet-01-session-check');

    if (await isLoggedIn(page)) {
      await settleSession(page, 'Session valid — no login needed');
      return page;
    }

    logger.info('[iparitet] No valid session — logging in with credentials');
    const outcome = await fillAndSubmitCredentials(page);
    if (outcome === 'awaiting_sms') {
      throw new ReauthRequiredError(
        BANK_ID,
        'iParitet запросил SMS — откройте Настройки → Банки → «Вход по SMS»',
      );
    }

    await settleSession(page, 'Login successful');
    return page;
  } catch (err) {
    await page.close().catch(() => null);
    if (isReauthRequired(err)) throw err;
    throw new Error(`[iparitet] Login failed: ${(err as Error).message}`);
  }
}

/**
 * Wait for the bearer token to land in sessionStorage, then persist the session.
 * A missing token is logged but not fatal — scraping waits for it again and
 * reports a precise error if it never appears.
 */
async function settleSession(page: Page, what: string): Promise<void> {
  const token = await waitForSessionToken(page);
  if (!token) {
    logger.warn('[iparitet] Dashboard reached but no session token yet', { url: page.url() });
  }
  await saveSession(BANK_ID);
  logger.info(`[iparitet] ${what}`, { url: page.url(), hasToken: !!token });
}

/**
 * Fill the login/password fields, submit, and wait until the SPA either reaches
 * the dashboard or shows the SMS prompt. Shared by the automated and interactive
 * login paths.
 */
async function fillAndSubmitCredentials(page: Page): Promise<'logged_in' | 'awaiting_sms'> {
  const bankLogin = getConfig('IPARITET_LOGIN');
  const bankPassword = getConfig('IPARITET_PASSWORD');
  if (!bankLogin || !bankPassword) {
    throw new Error('IPARITET_LOGIN and IPARITET_PASSWORD must be set');
  }

  const loginInput = await waitForInput(page, LOGIN_INPUT_SELECTORS);
  await loginInput.click();
  await loginInput.fill(bankLogin);

  const passwordInput = await waitForInput(page, PASSWORD_INPUT_SELECTORS);
  await passwordInput.click();
  await passwordInput.fill(bankPassword);

  await saveDebugSnapshot(page, 'iparitet-login-01-fields-filled');
  await clickFirstVisible(page, SUBMIT_SELECTORS, PASSWORD_INPUT_SELECTORS);

  const outcome = await waitForSmsOrDashboard(page);
  await saveDebugSnapshot(page, 'iparitet-login-02-after-submit');
  return outcome;
}

// ── Interactive SMS login (operator-driven, via the settings UI) ────────────────

interface PendingLogin {
  page: Page;
  createdAt: number;
}
let pending: PendingLogin | null = null;
const PENDING_TTL_MS = 5 * 60_000;

async function cancelPending(): Promise<void> {
  if (pending) {
    await pending.page.close().catch(() => null);
    pending = null;
  }
}

/**
 * Step 1: fill credentials, submit, and either land on the dashboard (session
 * still valid / no SMS) or reach the SMS prompt. On `awaiting_sms` the page is
 * held open until submitSmsCode() is called.
 */
async function startInteractiveLogin(): Promise<AuthStartResult> {
  await cancelPending();

  const ctx = await getBrowserContext(BANK_ID);
  const page = await ctx.newPage();
  attachTokenCapture(page);
  // Reserve `pending` immediately so status() reports awaiting_sms for the whole
  // attempt — this makes the scheduler skip this bank and prevents its
  // adapter.login()/resetContext() from closing this page mid-flow.
  pending = { page, createdAt: Date.now() };

  try {
    logger.info('[iparitet] Interactive login started');
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);

    if (await isLoggedIn(page)) {
      await saveSession(BANK_ID);
      await page.close().catch(() => null);
      pending = null;
      return { stage: 'logged_in', message: 'Сессия ещё активна — вход не потребовался.' };
    }

    const outcome = await fillAndSubmitCredentials(page);

    if (outcome === 'logged_in') {
      await saveSession(BANK_ID);
      await page.close().catch(() => null);
      pending = null;
      logger.info('[iparitet] Interactive login completed without SMS');
      return { stage: 'logged_in', message: 'Вход выполнен, SMS не потребовался.' };
    }

    // Refresh the timeout window to start when the SMS actually arrived.
    pending = { page, createdAt: Date.now() };
    logger.info('[iparitet] Awaiting SMS code from operator');
    return { stage: 'awaiting_sms', message: 'Банк отправил SMS-код. Введите его для завершения входа.' };
  } catch (err) {
    await saveDebugSnapshot(page, 'iparitet-sms-error-start');
    await page.close().catch(() => null);
    pending = null;
    throw err instanceof Error ? err : new Error(String(err));
  }
}

/**
 * Step 2: enter the SMS code into the held page and finish login. Persists the
 * session on success. On a rejected code the page is kept open so the operator
 * can re-enter without triggering a new SMS.
 */
async function submitSmsCode(code: string): Promise<void> {
  if (!pending) {
    throw new Error('Нет ожидающего входа. Сначала запросите SMS.');
  }
  if (Date.now() - pending.createdAt > PENDING_TTL_MS) {
    await cancelPending();
    throw new Error('Время ожидания ввода SMS истекло. Запросите код заново.');
  }

  const trimmed = code.trim();
  if (!trimmed) throw new Error('SMS-код не указан.');

  const page = pending.page;
  if (page.isClosed()) {
    pending = null;
    throw new Error('Сессия входа потеряна (браузер был перезапущен). Нажмите «Войти (запросить SMS)» заново.');
  }

  try {
    await fillSmsCode(page, trimmed);
    await saveDebugSnapshot(page, 'iparitet-sms-03-code-filled');
    // Many OTP components auto-submit on completion; still try a confirm button.
    await clickFirstVisible(page, SMS_CONFIRM_SELECTORS, SMS_INPUT_SELECTORS);
    await waitForLoginOutcome(page);
  } catch (err) {
    await saveDebugSnapshot(page, 'iparitet-sms-error-code').catch(() => null);
    throw err;
  }

  await page.waitForLoadState('networkidle').catch(() => null);
  await saveSession(BANK_ID);
  await saveDebugSnapshot(page, 'iparitet-sms-04-logged-in');
  logger.info('[iparitet] Interactive SMS login successful', { url: page.url() });

  await page.close().catch(() => null);
  pending = null;
}

registerInteractiveAuth(BANK_ID, {
  start: startInteractiveLogin,
  submitCode: submitSmsCode,
  status: (): AuthStage => (pending ? 'awaiting_sms' : 'idle'),
  cancel: cancelPending,
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * After submitting credentials, decide the outcome. The SPA's default login
 * always navigates to the `/registration/code` route, but when the account/device
 * does not need an SMS that page auto-redirects to the dashboard within a second
 * or two. So the dashboard always wins, and the code route is only treated as a
 * real SMS prompt if it *persists* (with a visible code input) past a grace period.
 */
async function waitForSmsOrDashboard(
  page: Page,
  timeout = 30_000,
): Promise<'logged_in' | 'awaiting_sms'> {
  const CODE_GRACE_MS = 8_000; // allow the code page to auto-redirect when no SMS is needed
  const deadline = Date.now() + timeout;
  let codeSeenAt: number | null = null;

  while (Date.now() < deadline) {
    if (await isLoggedIn(page)) return 'logged_in';

    // The code route is the definitive SMS signal — but the SPA also passes
    // through it when no SMS is needed, redirecting to the dashboard within a
    // second or two. So only conclude "SMS required" once it has persisted past
    // the grace period (the isLoggedIn check above wins if it redirects first).
    if (page.url().includes(SMS_CODE_ROUTE)) {
      codeSeenAt ??= Date.now();
      if (Date.now() - codeSeenAt >= CODE_GRACE_MS) return 'awaiting_sms';
    } else {
      codeSeenAt = null;
    }

    const errorText = await detectLoginError(page);
    if (errorText) throw new Error(`login rejected by bank: "${errorText}"`);

    await page.waitForTimeout(500);
  }

  // Timed out — if still parked on the code route, treat it as an SMS prompt.
  if (page.url().includes(SMS_CODE_ROUTE)) return 'awaiting_sms';
  const shape = await describeAuthPage(page);
  logger.warn('[iparitet] SMS/dashboard not detected — page shape', { shape });
  throw new Error(
    `login did not reach SMS prompt or dashboard within ${timeout}ms; still at ${page.url()}. Page shape: ${shape}`,
  );
}

/**
 * Wait for the SMS confirmation to resolve: success routes into `/app`; a
 * visible error banner throws; timeout throws with the page shape so the log is
 * self-diagnosing.
 */
async function waitForLoginOutcome(page: Page, timeout = 30_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await isLoggedIn(page)) return;

    const errorText = await detectLoginError(page);
    if (errorText) throw new Error(`login rejected by bank: "${errorText}"`);

    await page.waitForTimeout(500);
  }
  const shape = await describeAuthPage(page);
  logger.warn('[iparitet] Login did not complete — page shape', { shape });
  throw new Error(
    `login did not complete within ${timeout}ms; still at ${page.url()}. Page shape: ${shape}`,
  );
}

/** Locate the first *visible* SMS-code input, or null. */
async function locateSmsInput(page: Page): Promise<Locator | null> {
  for (const sel of SMS_INPUT_SELECTORS) {
    for (const input of await page.locator(sel).all().catch(() => [])) {
      if (await input.isVisible().catch(() => false)) return input;
    }
  }
  return null;
}

/**
 * Fill the SMS code. Handles both a single input and per-digit cells: if several
 * single-char inputs are visible, distribute the digits across them.
 */
async function fillSmsCode(page: Page, code: string): Promise<void> {
  // Per-digit cells (each maxlength=1) — fill one char per cell.
  const cells: Locator[] = [];
  for (const input of await page.locator('input[maxlength="1"]').all().catch(() => [])) {
    if (await input.isVisible().catch(() => false)) cells.push(input);
  }
  if (cells.length >= code.length) {
    for (let i = 0; i < code.length; i++) {
      await cells[i].click();
      await cells[i].fill(code[i]);
    }
    return;
  }

  const single = await locateSmsInput(page);
  if (!single) {
    const shape = await describeAuthPage(page);
    throw new Error(`SMS-поле не найдено на странице. Page shape: ${shape}`);
  }
  await single.click();
  await single.fill('');
  await single.fill(code);
}

/** Click the first visible match among `selectors`; fall back to Enter on a `fallbackInput`. */
async function clickFirstVisible(
  page: Page,
  selectors: string[],
  fallbackInputSelectors: string[],
): Promise<void> {
  for (const sel of selectors) {
    for (const btn of await page.locator(sel).all().catch(() => [])) {
      if (await btn.isVisible().catch(() => false) && await btn.isEnabled().catch(() => true)) {
        logger.debug(`[iparitet] Clicking: ${sel}`);
        await btn.click().catch(() => null);
        return;
      }
    }
  }
  for (const sel of fallbackInputSelectors) {
    const input = page.locator(sel).first();
    if (await input.isVisible().catch(() => false)) {
      await input.press('Enter').catch(() => null);
      return;
    }
  }
}

async function waitForInput(page: Page, selectors: string[], timeout = 30_000): Promise<Locator> {
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
    `[iparitet] No visible input found. Tried: ${selectors.join(', ')}. ` +
    'Set DEBUG_SCREENSHOTS=true to capture a snapshot.',
  );
}

/** Return the first visible error/validation message on the page, or ''. */
async function detectLoginError(page: Page): Promise<string> {
  const selectors = [
    '.error-message',
    '.form-error',
    '[role="alert"]',
    '.alert-danger',
    'app-hint.error',
    '.mat-error',
  ];
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel).first();
      if (await loc.isVisible({ timeout: 200 })) {
        const text = (await loc.textContent())?.trim();
        if (text) return text.replace(/\s+/g, ' ').slice(0, 300);
      }
    } catch { /* try next */ }
  }
  return '';
}

/** Compact JSON description of every input and button — used to calibrate selectors from the log. */
async function describeAuthPage(page: Page): Promise<string> {
  try {
    const inputs = [];
    for (const l of await page.locator('input').all().catch(() => [])) {
      inputs.push({
        name: await l.getAttribute('name').catch(() => null),
        id: await l.getAttribute('id').catch(() => null),
        class: await l.getAttribute('class').catch(() => null),
        formcontrolname: await l.getAttribute('formcontrolname').catch(() => null),
        type: await l.getAttribute('type').catch(() => null),
        inputmode: await l.getAttribute('inputmode').catch(() => null),
        autocomplete: await l.getAttribute('autocomplete').catch(() => null),
        maxlength: await l.getAttribute('maxlength').catch(() => null),
        visible: await l.isVisible().catch(() => false),
      });
    }
    const buttons = [];
    for (const b of await page.locator('button, a[role="button"]').all().catch(() => [])) {
      buttons.push({
        text: ((await b.textContent().catch(() => '')) || '').trim().slice(0, 40),
        visible: await b.isVisible().catch(() => false),
      });
    }
    return JSON.stringify({ url: page.url(), inputs, buttons });
  } catch (err) {
    return `(describe failed: ${(err as Error).message})`;
  }
}
