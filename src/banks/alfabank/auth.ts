import { Page, Locator, Frame } from 'playwright';
import { getBrowserContext, saveSession } from '../../scraper/browser';
import { logger } from '../../logger';
import { saveDebugSnapshot } from '../../utils/debug';
import { getConfig } from '../../config/store';
import {
  registerInteractiveAuth,
  ReauthRequiredError,
  isReauthRequired,
  AuthStartResult,
  AuthStage,
} from '../../auth/interactive';

const BANK_ID = 'alfabank';
const BASE_URL = 'https://online.alfabank.by';
const CHECK_USER_URL = `${BASE_URL}/Bia.Portlets.Ib.Alfa.Membership.Login/Login/CheckCurrentUser`;

// Best-effort selectors for the SMS one-time-code field and its confirm button.
// Alfa's exact markup is not knowable without a live snapshot — these cast a wide
// net; calibrate against ./data/debug/alfabank-sms-*.html if the flow stalls.
// Alfa's login page keeps the visible code field as name="MCode" (maxlength 4)
// while the UserName/Password fields stay in the DOM. Match the code field
// precisely and require visibility (findSmsFrame checks isVisible) so the plain
// login page doesn't false-trigger.
const SMS_INPUT_SELECTORS = [
  'input[name="MCode"]',
  'input[name="SmsCode"]',
  'input[autocomplete="one-time-code"]',
  'input[name*="otp" i]',
  'input[name*="sms" i]',
  'input[id*="otp" i]',
  'input[id*="code" i]',
];
const SMS_CONFIRM_SELECTORS = [
  'button:has-text("Подтвердить")',
  'button:has-text("Продолжить")',
  'button:has-text("Войти")',
  'button[type="submit"]',
  'input[type="submit"]',
];

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

// ── Auto-login guard ──────────────────────────────────────────────────────────
//
// Alfa asks for an SMS only when it challenges a new device/session — an ordinary
// login/password sign-in on an already-trusted device goes straight through. So
// the scheduler DOES submit credentials (otherwise the session dying overnight
// means a manual click every morning). The moment the bank actually holds on the
// SMS prompt, or rejects the credentials, automatic login is blocked until an
// operator completes the interactive flow — so a cron tick can never fire an SMS
// (or a bad-password attempt) every cycle.
const AUTO_LOGIN_BLOCK_MS = 6 * 60 * 60_000;
let autoLoginBlockedUntil = 0;
let autoLoginBlockReason = '';

function blockAutoLogin(reason: string): void {
  autoLoginBlockedUntil = Date.now() + AUTO_LOGIN_BLOCK_MS;
  autoLoginBlockReason = reason;
  logger.warn('[alfabank] Automatic login blocked — operator action required', { reason });
}

/** Reason string while automatic credential login is blocked, else null. */
function autoLoginBlock(): string | null {
  if (Date.now() >= autoLoginBlockedUntil) return null;
  return autoLoginBlockReason;
}

/** Re-enable automatic credential login (successful interactive login / creds changed). */
export function resetAutoLoginBlock(): void {
  autoLoginBlockedUntil = 0;
  autoLoginBlockReason = '';
}

/**
 * Automated (scheduler) login.
 *
 * Reuses the persisted session and, if it is gone, signs in with credentials —
 * that normally succeeds without an SMS, so the morning sync no longer needs an
 * operator. Only if the bank genuinely holds on the SMS prompt (or rejects the
 * credentials) does it throw {@link ReauthRequiredError} and block further
 * automatic attempts, so no SMS is fired every cycle.
 */
export async function login(): Promise<Page> {
  requireCredentials();

  const ctx = await getBrowserContext(BANK_ID);
  const page = await ctx.newPage();

  try {
    logger.debug('[alfabank] Restoring session');
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
    await saveDebugSnapshot(page, 'alfabank-01-session-check');

    if (await sessionIsValid(page)) {
      await saveSession(BANK_ID);
      logger.info('[alfabank] Session valid — authenticated without SMS', { url: page.url() });
      return page;
    }

    const blocked = autoLoginBlock();
    if (blocked) throw new ReauthRequiredError(BANK_ID, blocked);

    logger.info('[alfabank] No valid session — logging in with credentials');
    const outcome = await fillAndSubmitCredentials(page);
    if (outcome === 'awaiting_sms') {
      blockAutoLogin('Альфа-Банк запросил SMS-код — откройте Настройки → Банки → «Вход по SMS»');
      throw new ReauthRequiredError(BANK_ID, autoLoginBlockReason);
    }

    await saveSession(BANK_ID);
    logger.info('[alfabank] Login successful (no SMS required)', { url: page.url() });
    return page;
  } catch (err) {
    await page.close().catch(() => null);
    if (isReauthRequired(err)) throw err;
    const message = (err as Error).message;
    if (/login rejected by bank/i.test(message)) {
      // Wrong/expired credentials — retrying every cycle would lock the account.
      blockAutoLogin(`Банк отклонил вход: ${message}`);
      throw new ReauthRequiredError(BANK_ID, autoLoginBlockReason);
    }
    throw new Error(`[alfabank] Login failed: ${message}`);
  }
}

function requireCredentials(): { bankLogin: string; bankPassword: string } {
  const bankLogin = getConfig('ALFABANK_LOGIN') ?? getConfig('BANK_LOGIN');
  const bankPassword = getConfig('ALFABANK_PASSWORD') ?? getConfig('BANK_PASSWORD');
  if (!bankLogin || !bankPassword) {
    throw new Error('ALFABANK_LOGIN and ALFABANK_PASSWORD must be set');
  }
  return { bankLogin, bankPassword };
}

/** True when the landing page is the authenticated cabinet, not the login form. */
async function sessionIsValid(page: Page): Promise<boolean> {
  const loginFormVisible = await page
    .locator('input[name="Password"]')
    .isVisible({ timeout: 3000 })
    .catch(() => false);
  if (loginFormVisible) return false;
  return isLoggedIn(page);
}

/**
 * Fill the login/password fields, submit, and wait until the bank either lands on
 * the cabinet or shows the SMS prompt. Shared by the automated and interactive
 * login paths.
 */
async function fillAndSubmitCredentials(page: Page): Promise<'logged_in' | 'awaiting_sms'> {
  const { bankLogin, bankPassword } = requireCredentials();

  const usernameInput = await waitForInput(page, [
    'input[name="UserName"]',
    'input[autocomplete="username"]',
    'form input[type="text"]',
  ]);
  await usernameInput.click();
  await usernameInput.fill(bankLogin);

  const passwordInput = await waitForInput(page, [
    'input[name="Password"]',
    'input[type="password"]',
  ]);
  await passwordInput.click();
  await passwordInput.fill(bankPassword);

  await saveDebugSnapshot(page, 'alfabank-sms-01-fields-filled');
  await clickSubmit(page);

  const outcome = await waitForSmsOrDashboard(page);
  await saveDebugSnapshot(page, 'alfabank-sms-02-after-submit');
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
  requireCredentials();

  await cancelPending();

  const ctx = await getBrowserContext(BANK_ID);
  const page = await ctx.newPage();
  // Reserve `pending` immediately so status() reports awaiting_sms for the whole
  // attempt — this makes the scheduler skip this bank and prevents its
  // adapter.login()/resetContext() from closing this page mid-flow.
  pending = { page, createdAt: Date.now() };

  try {
    logger.info('[alfabank] Interactive login started');
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);

    if (await sessionIsValid(page)) {
      await saveSession(BANK_ID);
      await page.close().catch(() => null);
      pending = null;
      resetAutoLoginBlock();
      return { stage: 'logged_in', message: 'Сессия ещё активна — вход не потребовался.' };
    }

    const outcome = await fillAndSubmitCredentials(page);

    if (outcome === 'logged_in') {
      await saveSession(BANK_ID);
      await page.close().catch(() => null);
      pending = null;
      resetAutoLoginBlock();
      logger.info('[alfabank] Interactive login completed without SMS');
      return { stage: 'logged_in', message: 'Вход выполнен, SMS не потребовался.' };
    }

    // Refresh the timeout window to start when the SMS actually arrived.
    pending = { page, createdAt: Date.now() };
    logger.info('[alfabank] Awaiting SMS code from operator');
    return { stage: 'awaiting_sms', message: 'Банк отправил SMS-код. Введите его для завершения входа.' };
  } catch (err) {
    await saveDebugSnapshot(page, 'alfabank-sms-error-start');
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
    const found = await locateSmsInput(page);
    if (!found) {
      const shape = await describeAuthPage(page);
      throw new Error(`SMS-поле не найдено на странице. Page shape: ${shape}`);
    }
    const { frame, input: smsInput } = found;
    await smsInput.click();
    await smsInput.fill('');
    await smsInput.fill(trimmed);
    await saveDebugSnapshot(page, 'alfabank-sms-03-code-filled');
    await clickSmsConfirm(frame);
    await waitForLoginOutcome(page);
  } catch (err) {
    // Keep the pending page alive so the operator can retry the same SMS code.
    await saveDebugSnapshot(page, 'alfabank-sms-error-code').catch(() => null);
    throw err;
  }

  await page.waitForLoadState('networkidle').catch(() => null);
  await saveSession(BANK_ID);
  await saveDebugSnapshot(page, 'alfabank-sms-04-logged-in');
  logger.info('[alfabank] Interactive SMS login successful', { url: page.url() });

  await page.close().catch(() => null);
  pending = null;
  resetAutoLoginBlock();
}

registerInteractiveAuth(BANK_ID, {
  start: startInteractiveLogin,
  submitCode: submitSmsCode,
  status: (): AuthStage => (pending ? 'awaiting_sms' : 'idle'),
  cancel: cancelPending,
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * After submitting credentials, poll for one of three outcomes:
 *   - dashboard reached / login form gone → 'logged_in';
 *   - an SMS code field appeared → 'awaiting_sms';
 *   - a visible error banner → throw with its text.
 */
async function waitForSmsOrDashboard(
  page: Page,
  timeout = 20_000,
): Promise<'logged_in' | 'awaiting_sms'> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (page.url().includes('/Cabinet/')) return 'logged_in';

    // The SMS code field (name="MCode") appears on the same page as the login
    // form, so detection is by the visible code field, not by the login form
    // disappearing.
    if (await locateSmsInput(page)) return 'awaiting_sms';
    if (await isLoggedIn(page)) return 'logged_in';

    const errorText = await detectLoginError(page);
    if (errorText) throw new Error(`login rejected by bank: "${errorText}"`);

    await page.waitForTimeout(500);
  }
  // Neither SMS field nor dashboard nor a known error was detected — dump the
  // page's form structure so the log itself reveals the real markup to calibrate
  // SMS_INPUT_SELECTORS / SMS_CONFIRM_SELECTORS against.
  const shape = await describeAuthPage(page);
  logger.warn('[alfabank] SMS/dashboard not detected — page shape', { shape });
  throw new Error(
    `login did not reach SMS prompt or dashboard within ${timeout}ms; still at ${page.url()}. Page shape: ${shape}`,
  );
}

/**
 * Locate the *visible* SMS-code input across all frames, returning it together
 * with its frame. Selectors are tried in priority order and each candidate is
 * checked for visibility — Alfa keeps a hidden `SmsCode` field in the DOM before
 * the visible `MCode` one, so picking "first in DOM" would grab the hidden field.
 */
async function locateSmsInput(page: Page): Promise<{ frame: Frame; input: Locator } | null> {
  for (const frame of page.frames()) {
    for (const sel of SMS_INPUT_SELECTORS) {
      for (const input of await frame.locator(sel).all().catch(() => [])) {
        if (await input.isVisible().catch(() => false)) {
          return { frame, input };
        }
      }
    }
  }
  return null;
}

/**
 * Compact JSON description of every input and button across ALL frames.
 * Locator-based (not page.evaluate) so it survives SPA navigations, and
 * frame-aware so an SMS form rendered inside an iframe is revealed. Used to
 * calibrate SMS selectors from the log when debug snapshots on the host are
 * not reachable.
 */
async function describeAuthPage(page: Page): Promise<string> {
  try {
    const frames = [];
    for (const frame of page.frames()) {
      const inputs = [];
      for (const l of await frame.locator('input').all().catch(() => [])) {
        inputs.push({
          name: await l.getAttribute('name').catch(() => null),
          type: await l.getAttribute('type').catch(() => null),
          placeholder: await l.getAttribute('placeholder').catch(() => null),
          autocomplete: await l.getAttribute('autocomplete').catch(() => null),
          inputmode: await l.getAttribute('inputmode').catch(() => null),
          maxlength: await l.getAttribute('maxlength').catch(() => null),
          id: await l.getAttribute('id').catch(() => null),
          visible: await l.isVisible().catch(() => false),
        });
      }
      const buttons = [];
      for (const b of await frame.locator('button, input[type="submit"], a[role="button"]').all().catch(() => [])) {
        buttons.push({
          text: ((await b.textContent().catch(() => '')) || '').trim().slice(0, 40),
          visible: await b.isVisible().catch(() => false),
        });
      }
      frames.push({ url: frame.url(), isMain: frame === page.mainFrame(), inputs, buttons });
    }
    return JSON.stringify({ url: page.url(), frames });
  } catch (err) {
    return `(describe failed: ${(err as Error).message})`;
  }
}

/**
 * Wait for the login attempt to resolve, polling for one of three outcomes:
 *   - success: URL navigated into the authenticated Cabinet, or the password
 *     field disappeared (SPA replaced the form);
 *   - failure: a validation/error banner became visible → throw with its text;
 *   - timeout: none of the above within the deadline → throw with the current
 *     URL and any error text found, so the log line is self-diagnosing.
 */
async function waitForLoginOutcome(page: Page, timeout = 30_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (page.url().includes('/Cabinet/')) return;
    if (await isLoggedIn(page)) return;

    const errorText = await detectLoginError(page);
    if (errorText) {
      throw new Error(`login rejected by bank: "${errorText}"`);
    }

    await page.waitForTimeout(500);
  }

  const shape = await describeAuthPage(page);
  logger.warn('[alfabank] Login did not complete — page shape', { shape });
  throw new Error(
    `login did not complete within ${timeout}ms; still at ${page.url()}. Page shape: ${shape}`,
  );
}

/**
 * Return the first visible error/validation message on the login page, or ''.
 * Selectors are best-effort — Alfa's exact markup may change, so we cast a wide net.
 */
async function detectLoginError(page: Page): Promise<string> {
  const selectors = [
    '.validation-summary-errors',
    '.field-validation-error',
    '[role="alert"]',
    '.alert-danger',
    '.error-message',
    '.b-form__error',
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

async function clickSmsConfirm(scope: Page | Frame): Promise<void> {
  // Alfa renders duplicate buttons (e.g. two "Подтвердить"), the first hidden —
  // so click the first *visible* match, not the first in DOM order.
  for (const sel of SMS_CONFIRM_SELECTORS) {
    for (const btn of await scope.locator(sel).all().catch(() => [])) {
      if (await btn.isVisible().catch(() => false)) {
        logger.debug(`[alfabank] Clicking SMS confirm: ${sel}`);
        await btn.click();
        return;
      }
    }
  }
  logger.debug('[alfabank] No SMS confirm button found, pressing Enter on code field');
  for (const sel of SMS_INPUT_SELECTORS) {
    for (const input of await scope.locator(sel).all().catch(() => [])) {
      if (await input.isVisible().catch(() => false)) {
        await input.press('Enter');
        return;
      }
    }
  }
}
