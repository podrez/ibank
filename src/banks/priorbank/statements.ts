import { Page } from 'playwright';
import { ScrapedTransaction, StatementRequest } from '../types';
import { dismissKendoOverlay } from './auth';
import { logger } from '../../logger';
import fs from 'fs';
import path from 'path';

const BASE_URL = 'https://www.ibank.priorbank.by';
const STATEMENT_URL = `${BASE_URL}/v1/Cabinet/101`;
const DEBUG_DIR = './data/debug';

export async function scrapeStatement(
  page: Page,
  req: StatementRequest,
): Promise<ScrapedTransaction[]> {
  logger.info('[priorbank:statement] ═══ Starting statement scrape ═══', {
    account: req.accountNumber,
    from: req.dateFrom,
    to: req.dateTo,
  });

  const saveSnap = async (name: string) => {
    if (process.env.DEBUG_SCREENSHOTS !== 'true') return;
    try {
      if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });
      const safe = req.accountNumber.replace(/[^A-Z0-9]/gi, '_');
      const file = `priorbank-stmt-${safe}-${name}`;
      await page.screenshot({ path: path.join(DEBUG_DIR, `${file}.png`), fullPage: true }).catch(() => null);
      fs.writeFileSync(path.join(DEBUG_DIR, `${file}.html`), await page.content().catch(() => ''));
      logger.info(`[priorbank:statement] Snapshot saved: ./data/debug/${file}.png`);
    } catch { /* ignore */ }
  };

  // Step 1: Navigate to statement page
  logger.info('[priorbank:statement] Step 1: Navigating to statement page', { url: STATEMENT_URL });
  try {
    await page.goto(STATEMENT_URL, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    await page.waitForTimeout(2_000);
  } catch (err) {
    logger.error('[priorbank:statement] Failed to navigate to statement page', { error: (err as Error).message });
    await saveSnap('00-nav-error');
    return [];
  }

  const urlAfterNav = page.url();
  logger.info('[priorbank:statement] Step 1 result: current URL', { url: urlAfterNav });

  if (urlAfterNav.includes('login') || urlAfterNav.includes('Login')) {
    logger.error('[priorbank:statement] Redirected to login — session expired');
    await saveSnap('00-session-expired');
    return [];
  }

  await dismissKendoOverlay(page);
  await saveSnap('01-statement-page-loaded');

  // Step 2: Select account from Kendo dropdown
  logger.info('[priorbank:statement] Step 2: Looking for account selector');
  const accountSelected = await selectAccount(page, req.accountNumber);
  logger.info('[priorbank:statement] Step 2 result: account selected', { success: accountSelected });
  await page.waitForTimeout(1_500);
  await saveSnap('02-account-selected');

  // Step 3: Fill date range
  logger.info('[priorbank:statement] Step 3: Filling date range', { from: req.dateFrom, to: req.dateTo });
  const datesSet = await fillDateRange(page, req.dateFrom, req.dateTo);
  logger.info('[priorbank:statement] Step 3 result: dates filled', { success: datesSet });
  await saveSnap('03-dates-filled');

  // Step 4: Submit — Priorbank returns server-rendered HTML (no JSON API)
  logger.info('[priorbank:statement] Step 4: Clicking submit and waiting for page reload');
  await clickSubmitButton(page);
  await saveSnap('04-after-submit');

  // Step 5: Parse Kendo Grid rows
  logger.info('[priorbank:statement] Step 5: Parsing Kendo Grid data from DOM');
  const transactions = await domScrape(page, req);
  logger.info('[priorbank:statement] Step 5 result', { count: transactions.length });
  return transactions;
}

// ── Step 2: Account selection ─────────────────────────────────────────────────

async function selectAccount(page: Page, accountNumber: string): Promise<boolean> {
  const selects = await page.locator('select').all();
  logger.debug('[priorbank:statement] Native <select> elements found', { count: selects.length });

  const kendoDropdowns = await page.locator('[data-role="dropdownlist"], [data-role="combobox"], .k-dropdown, .k-combobox').all();
  logger.debug('[priorbank:statement] Kendo dropdowns found', { count: kendoDropdowns.length });

  for (let i = 0; i < Math.min(selects.length, 5); i++) {
    const text = await selects[i].innerText().catch(() => '?');
    const name = await selects[i].getAttribute('name').catch(() => '?');
    logger.debug(`[priorbank:statement]   select[${i}] name="${name}" text="${text.slice(0, 100)}"`);
  }

  const kendoCandidates = [
    '[data-role="dropdownlist"]',
    '[data-role="combobox"]',
    '.k-dropdown-wrap',
    '.k-picker-wrap',
  ];

  for (const sel of kendoCandidates) {
    const els = await page.locator(sel).all();
    for (let i = 0; i < els.length; i++) {
      const el = els[i];
      const text = await el.innerText().catch(() => '');
      logger.debug(`[priorbank:statement]   Kendo ${sel}[${i}] text="${text.slice(0, 80)}"`);

      if (
        text.includes('BY') ||
        text.toLowerCase().includes('счет') ||
        text.toLowerCase().includes('account') ||
        text.toLowerCase().includes('счёт')
      ) {
        logger.info(`[priorbank:statement]   → Account dropdown found (${sel}[${i}]): "${text.slice(0, 60)}"`);
        await el.click().catch(() => null);
        await page.waitForTimeout(500);

        const optionClicked = await clickKendoOption(page, accountNumber);
        if (optionClicked) return true;
      }
    }
  }

  for (const sel of ['select[name*="account" i]', 'select[name*="Account"]', 'select[id*="account" i]', 'select']) {
    const selEl = page.locator(sel).first();
    if (await selEl.isVisible({ timeout: 1_000 }).catch(() => false)) {
      const options = await selEl.locator('option').all();
      logger.debug(`[priorbank:statement]   Native select "${sel}" has ${options.length} options`);
      for (const opt of options) {
        const val = await opt.getAttribute('value').catch(() => '');
        const text = await opt.innerText().catch(() => '');
        logger.debug(`[priorbank:statement]     option value="${val}" text="${text.slice(0, 60)}"`);
        if (val?.includes(accountNumber) || text.includes(accountNumber)) {
          logger.info(`[priorbank:statement]   → Selecting option: value="${val}"`);
          await selEl.selectOption({ value: val! });
          return true;
        }
      }
    }
  }

  logger.warn('[priorbank:statement] Could not find account selector — proceeding without selection');
  return false;
}

async function clickKendoOption(page: Page, accountNumber: string): Promise<boolean> {
  const listItems = await page.locator('.k-list li, .k-popup li, [role="option"]').all();
  logger.debug(`[priorbank:statement]   Kendo list items: ${listItems.length}`);
  for (const item of listItems) {
    const text = await item.innerText().catch(() => '');
    logger.debug(`[priorbank:statement]     option: "${text.slice(0, 80)}"`);
    if (text.includes(accountNumber)) {
      logger.info(`[priorbank:statement]   → Clicking Kendo option: "${text.slice(0, 60)}"`);
      await item.click();
      return true;
    }
  }
  return false;
}

// ── Step 3: Fill date range ───────────────────────────────────────────────────

/**
 * Convert ISO date (yyyy-mm-dd) to digit sequence for Kendo DatePicker masked input.
 * Priorbank uses dd.mm.yyyy mask — type digits left to right: ddmmyyyy.
 * e.g. "2026-04-01" → "01042026"
 */
function isoToMaskDigits(iso: string): string {
  const [yyyy, mm, dd] = iso.split('-');
  return `${dd}${mm}${yyyy}`;
}

/**
 * Fill a Kendo DatePicker field reliably.
 * Single click to focus → Home to jump to first segment (dd) → type digits one by one.
 */
async function fillKendoDate(
  page: Page,
  locator: import('playwright').Locator,
  isoDate: string,
  label: string,
): Promise<void> {
  const digits = isoToMaskDigits(isoDate);
  logger.info(`[priorbank:statement]   Filling ${label}: "${isoDate}" → digits "${digits}"`);

  await locator.click();
  await page.waitForTimeout(100);
  await page.keyboard.press('Home');
  await page.waitForTimeout(50);

  for (const ch of digits) {
    await page.keyboard.press(ch);
    await page.waitForTimeout(40);
  }

  await page.waitForTimeout(200);
  const val = await locator.inputValue().catch(() => '?');
  logger.info(`[priorbank:statement]   ${label} value after fill: "${val}"`);
}

async function fillDateRange(page: Page, dateFrom: string, dateTo: string): Promise<boolean> {
  // Ensure "за период" radio is selected
  const periodRadio = page.locator('#Periods_Period');
  if (await periodRadio.isVisible({ timeout: 1_000 }).catch(() => false)) {
    const checked = await periodRadio.isChecked().catch(() => false);
    if (!checked) {
      logger.info('[priorbank:statement]   Selecting "за период" radio button');
      await periodRadio.click();
      await page.waitForTimeout(300);
    } else {
      logger.debug('[priorbank:statement]   "за период" already selected');
    }
  } else {
    logger.warn('[priorbank:statement]   #Periods_Period radio not found');
  }

  // Kendo DatePicker fields identified by data-bind="value: DateFrom/DateTo"
  const fromEl = page.locator('input[data-bind*="DateFrom"]').first();
  const toEl   = page.locator('input[data-bind*="DateTo"]').first();

  const fromVisible = await fromEl.isVisible({ timeout: 2_000 }).catch(() => false);
  const toVisible   = await toEl.isVisible({ timeout: 2_000 }).catch(() => false);

  logger.info('[priorbank:statement]   Date fields visible', { fromVisible, toVisible });

  if (fromVisible) {
    await fillKendoDate(page, fromEl, dateFrom, 'DateFrom');
  } else {
    logger.warn('[priorbank:statement]   DateFrom input not found (data-bind*="DateFrom")');
  }

  if (toVisible) {
    await fillKendoDate(page, toEl, dateTo, 'DateTo');
  } else {
    logger.warn('[priorbank:statement]   DateTo input not found (data-bind*="DateTo")');
  }

  return fromVisible && toVisible;
}

// ── Step 4: Submit ────────────────────────────────────────────────────────────

async function clickSubmitButton(page: Page): Promise<void> {
  const submitSelectors = [
    'button:has-text("Применить")',
    'button:has-text("Показать")',
    'button:has-text("Сформировать")',
    'button:has-text("Найти")',
    'button:has-text("Поиск")',
    'button:has-text("Получить")',
    'button[type="submit"]',
    'input[type="submit"]',
  ];

  const buttons = await page.locator('button:visible, input[type="submit"]:visible').all();
  logger.debug(`[priorbank:statement] Visible buttons: ${buttons.length}`);
  for (let i = 0; i < Math.min(buttons.length, 10); i++) {
    const text = await buttons[i].innerText().catch(() => '?');
    const type = await buttons[i].getAttribute('type').catch(() => '?');
    logger.debug(`[priorbank:statement]   button[${i}] type="${type}" text="${text.slice(0, 60)}"`);
  }

  for (const sel of submitSelectors) {
    const btn = page.locator(sel).first();
    if (await btn.isVisible({ timeout: 800 }).catch(() => false)) {
      const text = await btn.innerText().catch(() => sel);
      logger.info(`[priorbank:statement]   → Clicking submit: "${text.slice(0, 40)}" (${sel})`);
      await btn.click();
      // Wait for Kendo Grid data rows — not networkidle, which would block on
      // third-party fraud-detection calls (fp-back.facct.by) for ~27 seconds.
      await page.waitForSelector('tr[data-uid]', { timeout: 30_000 }).catch(() => null);
      return;
    }
  }

  logger.warn('[priorbank:statement] No submit button found');
}

// ── Step 5: DOM scraping — Kendo Grid ────────────────────────────────────────

/**
 * Kendo Grid column layout (confirmed from page HTML):
 *  0  DocumentDate        dd.mm.yyyy
 *  1  DocumentNumber      reference
 *  2  DestinationPayment  description (display:none — use textContent)
 *  3  FactTime247         (hidden, skip)
 *  4  OperationAttachments (skip)
 *  5  Iso                 internal numeric code (skip)
 *  6  Валюта корреспондента "BYN"/"EUR" etc. (display:none — use textContent)
 *  7  CorrespondentBankCode (hidden, skip)
 *  8  CorrespondentName   (visible)
 *  9  Unp                 (hidden, skip)
 * 10  AccountNumber       correspondent IBAN (hidden, skip)
 * 11  DebitAmount         e.g. "386.52" or "1 500.00"
 * 12  CreditAmount
 */
async function domScrape(page: Page, req: StatementRequest): Promise<ScrapedTransaction[]> {
  const fallbackCurrency = currencyFromAccount(req.accountNumber);

  // Extract all rows in one browser-side evaluate() instead of per-cell IPC round-trips.
  // 474 rows × 8 Playwright calls ≈ 30 s; one evaluate() ≈ <1 s.
  // No TypeScript syntax inside the callback — tsx injects __name helpers that
  // are not available when the function is serialised and run in the browser.
  // Inline all cell reads — avoid named arrow functions inside evaluate because
  // tsx/esbuild injects __name() helpers for them, which are not available when
  // the callback is serialised and executed inside the browser.
  const rawRows = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('tr[data-uid]'));
    const out: Array<{date:string;docNumber:string;description:string;currency:string;counterpartyName:string;unp:string;debit:string;credit:string}> = [];
    rows.forEach(function(row) {
      const cells = row.querySelectorAll('td');
      if (cells.length < 13) return;
      out.push({
        date:            (cells[0].textContent  || '').trim(),
        docNumber:       (cells[1].textContent  || '').trim(),
        description:     (cells[2].textContent  || '').trim(),
        currency:        (cells[6].textContent  || '').trim(),
        counterpartyName:(cells[8].textContent  || '').trim(),
        unp:             (cells[9].textContent  || '').trim(),
        debit:           (cells[11].textContent || '').trim(),
        credit:          (cells[12].textContent || '').trim(),
      });
    });
    return out;
  }) as Array<{ date: string; docNumber: string; description: string; currency: string; counterpartyName: string; unp: string; debit: string; credit: string }>;

  logger.info(`[priorbank:statement] DOM: found ${rawRows.length} Kendo Grid data rows`);

  if (rawRows.length === 0) {
    logger.warn('[priorbank:statement] ✗ No tr[data-uid] rows — check snapshot 04-after-submit.png');
    return [];
  }

  const parseAmt = (s: string) => {
    const n = parseFloat(s.replace(/\s+/g, '').replace(',', '.'));
    return isNaN(n) ? 0 : Math.abs(n);
  };

  const transactions: ScrapedTransaction[] = [];
  let skipped = 0;

  for (const r of rawRows) {
    const dm = r.date.match(/(\d{2})\.(\d{2})\.(\d{4})/);
    if (!dm) { skipped++; continue; }
    const transactionDate = `${dm[3]}-${dm[2]}-${dm[1]}`;

    const debit  = parseAmt(r.debit);
    const credit = parseAmt(r.credit);
    if (debit === 0 && credit === 0) { skipped++; continue; }

    transactions.push({
      transactionDate,
      reference:        r.docNumber          || undefined,
      description:      r.description,
      debit:            debit  > 0 ? debit  : undefined,
      credit:           credit > 0 ? credit : undefined,
      currency:         r.currency           || fallbackCurrency,
      counterpartyUnp:  r.unp                || undefined,
      counterpartyName: r.counterpartyName   || undefined,
    });
  }

  logger.info(
    `[priorbank:statement] DOM: parsed ${transactions.length} transactions, skipped ${skipped} rows`,
  );
  return transactions;
}

/** Derive ISO 4217 currency text from Priorbank account number (last 3 digits = numeric code). */
function currencyFromAccount(accountNumber: string): string {
  const map: Record<string, string> = {
    '933': 'BYN', '978': 'EUR', '840': 'USD', '643': 'RUB', '156': 'CNY',
  };
  return map[accountNumber.slice(-3)] ?? 'BYN';
}
