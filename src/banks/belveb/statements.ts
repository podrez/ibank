import { Page } from 'playwright';
import { ScrapedTransaction, StatementRequest } from '../types';
import { logger } from '../../logger';
import { db, schema } from '../../db';
import { and, eq } from 'drizzle-orm';
import { parseDate, isoToDMY } from '../../utils/dates';
import { makeSnapper } from '../../utils/debug';
import { strPick, numPick } from '../../utils/scrape';

const BASE_URL = 'https://dbo2.bveb.by';
const VPSK_BASE = '/Cabinet/Accounts/Vpsk/Extract/';

const CURRENCY_CODES: Record<string, string> = {
  BYN: '933', USD: '840', EUR: '978', RUB: '643', CNY: '156',
};

export async function scrapeStatement(
  page: Page,
  req: StatementRequest,
): Promise<ScrapedTransaction[]> {
  logger.info('[belveb:stmt] ═══ Starting statement scrape ═══', {
    account: req.accountNumber, from: req.dateFrom, to: req.dateTo,
  });

  const snap = makeSnapper(page, 'belveb', req.accountNumber);

  // 1. Build URL with numeric currency code from DB; also keep ISO code for transactions
  const { isoCode: accountCurrency, numericCode: currencyCode } = await lookupCurrencyInfo(req.accountNumber);
  const vpskUrl = buildVpskUrl(req.accountNumber, currencyCode);
  logger.debug('[belveb:stmt] Navigating to Vpsk Extract', { url: vpskUrl });

  await page.goto(vpskUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 });
  await page.waitForTimeout(1_500);
  await snap('01-vpsk-loaded');

  if (!page.url().includes('/Cabinet/')) {
    // BIA portal rejects direct Vpsk access when the accounts portlet hasn't been
    // initialized in the session yet (happens right after a fresh login / resetContext).
    // Navigating back to /Cabinet/ with networkidle gives the portal time to set up
    // the portlet state, after which the Vpsk URL succeeds on a second attempt.
    logger.warn('[belveb:stmt] Vpsk redirected to non-Cabinet URL — refreshing portal state and retrying', { url: page.url() });
    await page.goto(`${BASE_URL}/Cabinet/`, { waitUntil: 'networkidle', timeout: 25_000 });
    await page.waitForTimeout(2_000);
    await page.goto(vpskUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    await page.waitForTimeout(1_500);
    await snap('01b-vpsk-retry');

    if (!page.url().includes('/Cabinet/')) {
      logger.error('[belveb:stmt] Redirected away from Cabinet — session expired', { url: page.url() });
      throw new Error(`[belveb:stmt] Session expired — redirected to ${page.url()}`);
    }
  }

  // 2. Wait for the Vpsk portlet form to finish loading
  logger.debug('[belveb:stmt] Waiting for Vpsk portlet form...');
  await page.waitForFunction(
    () => {
      const prtl = document.querySelector('#prtl0, [data-portlet-order="0"]');
      if (!prtl) return false;
      const form = prtl.querySelector('form');
      return form !== null && prtl.querySelectorAll('input').length > 0;
    },
    { timeout: 25_000, polling: 400 },
  ).catch(() => null);
  await snap('02-portlet-loaded');

  // 3. Fill date range using Kendo JS API (most reliable on BIA platform)
  logger.debug('[belveb:stmt] Filling date range', { from: req.dateFrom, to: req.dateTo });
  await fillDatesViaKendo(page, req.dateFrom, req.dateTo);
  await page.waitForTimeout(400);
  await snap('03-dates-filled');

  // 4. Submit and wait for AJAX response.
  // BIA platform sends results to SubmitUrl=/Vpsk/List and updates #vpsk-list-result.
  logger.debug('[belveb:stmt] Submitting form and waiting for AJAX response...');
  let ajaxResponseHtml = '';
  try {
    const [response] = await Promise.all([
      page.waitForResponse(
        (r) => (r.url().includes('Vpsk/List') || r.url().includes('Vpsk/Index')) && r.request().method() === 'POST',
        { timeout: 35_000 },
      ),
      clickSubmit(page),
    ]);
    ajaxResponseHtml = await response.text();
    logger.debug('[belveb:stmt] AJAX response received', { bytes: ajaxResponseHtml.length, url: response.url() });
  } catch (err) {
    logger.warn('[belveb:stmt] waitForResponse timed out, falling back to DOM', { err: String(err) });
    await clickSubmit(page);
  }

  // Wait for DOM to settle after AJAX
  await page.waitForLoadState('networkidle').catch(() => null);
  await page.waitForTimeout(1_000);
  await snap('04-results');

  // 5. Extract all pages of transactions
  const allTransactions: ScrapedTransaction[] = [];

  // Page 1: AJAX response or DOM fallback
  if (ajaxResponseHtml.length > 100) {
    const page1 = extractFromHtml(ajaxResponseHtml, req, accountCurrency);
    if (page1.length > 0) {
      logger.info('[belveb:stmt] Page 1: extracted from AJAX response', { count: page1.length });
      allTransactions.push(...page1);
    } else {
      logger.debug('[belveb:stmt] AJAX HTML yielded 0 transactions, trying page DOM');
    }
  }

  if (allTransactions.length === 0) {
    const domTx = await extractFromPageDom(page, req, accountCurrency);
    logger.info('[belveb:stmt] Page 1: extracted from DOM', { count: domTx.length });
    allTransactions.push(...domTx);
  }

  // Subsequent pages: iterate Kendo Grid pager
  let pageNum = 1;
  while (true) {
    const nextBtn = await findNextPageButton(page);
    if (!nextBtn) break;

    pageNum++;
    logger.debug(`[belveb:stmt] Fetching page ${pageNum}`);

    let pageHtml = '';
    try {
      const [nextResponse] = await Promise.all([
        page.waitForResponse(
          (r) => (r.url().includes('Vpsk/List') || r.url().includes('Vpsk/Index')) && r.request().method() === 'POST',
          { timeout: 20_000 },
        ),
        nextBtn.click(),
      ]);
      pageHtml = await nextResponse.text();
      await page.waitForTimeout(500);
    } catch (err) {
      logger.warn(`[belveb:stmt] Page ${pageNum}: response timeout, trying DOM`, { err: String(err) });
      await page.waitForLoadState('networkidle').catch(() => null);
      await page.waitForTimeout(1_000);
    }

    let pageTx: ScrapedTransaction[] = [];
    if (pageHtml.length > 100) {
      pageTx = extractFromHtml(pageHtml, req, accountCurrency);
    }
    if (pageTx.length === 0) {
      pageTx = await extractFromPageDom(page, req, accountCurrency);
    }

    if (pageTx.length === 0) {
      logger.warn(`[belveb:stmt] Page ${pageNum}: 0 transactions — stopping pagination`);
      break;
    }

    allTransactions.push(...pageTx);
    logger.info(`[belveb:stmt] Page ${pageNum}: +${pageTx.length} (total: ${allTransactions.length})`);
  }

  if (allTransactions.length === 0) {
    logger.warn(
      '[belveb:stmt] No transactions found. ' +
      'Set DEBUG_SCREENSHOTS=true and inspect ./data/debug/ for belveb-stmt-* files.',
    );
  } else {
    logger.info('[belveb:stmt] All pages fetched', { total: allTransactions.length });
  }

  // Return to cabinet dashboard so the next balance sync finds the accounts widget.
  // BelVEB server-side session remembers the last visited portlet page and redirects
  // /Cabinet/ back to it, so we must explicitly navigate away after statement scraping.
  try {
    await page.goto('https://dbo2.bveb.by/Cabinet/', { waitUntil: 'domcontentloaded', timeout: 15_000 });
    await page.waitForTimeout(800);
    logger.info('[belveb:stmt] Returned to cabinet dashboard after statement scrape');
  } catch { /* non-fatal */ }

  return allTransactions;
}

// ── URL helpers ───────────────────────────────────────────────────────────────

async function lookupCurrencyInfo(accountNumber: string): Promise<{ isoCode: string; numericCode: string }> {
  try {
    const row = await db
      .select({ currency: schema.accounts.currency })
      .from(schema.accounts)
      .where(and(eq(schema.accounts.bank, 'belveb'), eq(schema.accounts.accountNumber, accountNumber)))
      .limit(1);
    const isoCode = row[0]?.currency ?? 'BYN';
    return { isoCode, numericCode: CURRENCY_CODES[isoCode] ?? '933' };
  } catch {
    return { isoCode: 'BYN', numericCode: '933' };
  }
}

function buildVpskUrl(accountNumber: string, currencyCode: string): string {
  return `${BASE_URL}${VPSK_BASE}?id=${encodeURIComponent(accountNumber)}&currency=${currencyCode}`;
}

// ── Date filling ──────────────────────────────────────────────────────────────

async function fillDatesViaKendo(page: Page, dateFrom: string, dateTo: string): Promise<void> {
  const fromDMY = isoToDMY(dateFrom);
  const toDMY = isoToDMY(dateTo);

  // Use kendo.dataFor() to set values via the MVVM ViewModel (BIA platform pattern).
  // Avoids named inner functions to prevent esbuild __name injection in page.evaluate.
  const filled = await page.evaluate(
    (args: { from: string; to: string }) => {
      try {
        const kendo = (window as unknown as Record<string, unknown>)['kendo'] as
          | { dataFor: (el: Element) => Record<string, unknown> | null | undefined }
          | undefined;
        if (!kendo) return false;
        const dateFromEl = document.querySelector('[data-bind*="DateFrom"], [name="DateFrom"]');
        if (!dateFromEl) return false;
        const vm = kendo.dataFor(dateFromEl) as { set?: (k: string, v: string) => void } | null;
        if (!vm || typeof vm.set !== 'function') return false;
        vm.set('DateFrom', args.from);
        vm.set('DateTo', args.to);
        return true;
      } catch {
        return false;
      }
    },
    { from: fromDMY, to: toDMY },
  );

  if (filled) {
    logger.debug('[belveb:stmt] Dates set via kendo.dataFor ViewModel');
    return;
  }

  // Fallback: simulate keyboard input on masked date inputs
  logger.debug('[belveb:stmt] kendo.dataFor unavailable, using keyboard simulation');
  await fillInputByKeyboard(page, [
    'input[name="DateFrom"]', '[data-bind*="DateFrom"]',
    '[data-role="maskeddatepicker"] input', '.k-datepicker input',
  ], fromDMY, true);
  await fillInputByKeyboard(page, [
    'input[name="DateTo"]', '[data-bind*="DateTo"]',
    '[data-role="maskeddatepicker"] input', '.k-datepicker input',
  ], toDMY, false);
}

async function fillInputByKeyboard(
  page: Page,
  selectors: string[],
  value: string,
  first: boolean,
): Promise<void> {
  // Masked date inputs (Kendo DatePicker) auto-insert separators — typing dots
  // causes cursor drift. Only send digits; the mask fills in the dots itself.
  const digits = value.replace(/\./g, '');

  for (const sel of selectors) {
    try {
      const all = await page.locator(sel).all();
      const el = first ? all[0] : all[all.length - 1];
      if (!el || !await el.isVisible({ timeout: 500 })) continue;
      await el.click();
      // Move cursor to the very beginning of the masked field before typing.
      // Triple-click or fill('') don't reliably reset position on masked inputs.
      await page.keyboard.press('Home');
      await page.waitForTimeout(50);
      await el.type(digits, { delay: 50 });
      await page.keyboard.press('Tab');
      await page.waitForTimeout(200);
      return;
    } catch { /* try next */ }
  }
}

// ── Submit ────────────────────────────────────────────────────────────────────

async function clickSubmit(page: Page): Promise<void> {
  const candidates = [
    '#form_prtl0 button[type="submit"]',
    '#form_prtl0 input[type="submit"]',
    'form[data-ajax="true"] button[type="submit"]',
    'form[data-ajax="true"] input[type="submit"]',
    'button[type="submit"]',
    'input[type="submit"]',
    'button:has-text("Показать")',
    'button:has-text("Сформировать")',
    'button:has-text("Получить")',
    'button:has-text("Найти")',
  ];
  for (const sel of candidates) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 600 })) {
        logger.debug(`[belveb:stmt] Clicking submit: ${sel}`);
        await btn.click();
        return;
      }
    } catch { continue; }
  }
  logger.warn('[belveb:stmt] No submit button found — trying Enter');
  await page.keyboard.press('Enter');
}

// ── Pagination ────────────────────────────────────────────────────────────────

async function findNextPageButton(page: Page): Promise<import('playwright').Locator | null> {
  // Kendo Grid pager "next page" — has k-state-disabled on the last page
  const selectors = [
    '.k-pager-next:not(.k-state-disabled)',
    'a.k-pager-nav[title*="след"]:not(.k-state-disabled)',
    'a.k-pager-nav[title*="Следующая"]:not(.k-state-disabled)',
  ];
  for (const sel of selectors) {
    const btn = page.locator(sel).first();
    if (await btn.isVisible({ timeout: 300 }).catch(() => false)) {
      return btn;
    }
  }
  return null;
}

// ── Transaction extraction ────────────────────────────────────────────────────

/** Parse transactions from arbitrary HTML (either AJAX response fragment or full page) */
function extractFromHtml(html: string, req: StatementRequest, accountCurrency: string): ScrapedTransaction[] {
  // Try JS Model embedded in a <script> IIFE
  const modelTx = extractModelFromScripts(html, accountCurrency);
  if (modelTx.length > 0) return modelTx;

  // Try Kendo Grid HTML table rows using fixed column positions
  return extractRowsFromHtml(html, accountCurrency);
}

function extractModelFromScripts(html: string, accountCurrency: string): ScrapedTransaction[] {
  // BIA pattern: (function(name, settings){require([name],fn);})('"module.name"', {Model:[...]});
  const scriptRe = /<script[^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = scriptRe.exec(html)) !== null) {
    const src = m[1];
    if (!src.includes('"Model"') && !src.includes("'Model'")) continue;

    const objMatch =
      src.match(/,\s*(\{[\s\S]*?"Model"\s*:\s*\[[\s\S]*?\][\s\S]*?\})\s*\)\s*;/) ??
      src.match(/new\s+Module\s*\(\s*(\{[\s\S]*?"Model"\s*:\s*\[[\s\S]*?\][\s\S]*?\})\s*\)/);
    if (!objMatch) continue;

    try {
      const cleaned = objMatch[1].replace(/new\s+Date\s*\((\d+)\)/g, '"$1"');
      const data = JSON.parse(cleaned) as { Model?: unknown[] };
      if (!Array.isArray(data?.Model) || data.Model.length === 0) continue;
      const results = data.Model
        .map((item) => parseApiItem(item as Record<string, unknown>, accountCurrency))
        .filter((t): t is ScrapedTransaction => t !== null);
      if (results.length > 0) return results;
    } catch { continue; }
  }
  return [];
}

function extractRowsFromHtml(html: string, accountCurrency: string): ScrapedTransaction[] {
  // Column layout from Vpsk/List response — see extractKendoGridFromPage for details
  const results: ScrapedTransaction[] = [];
  const rowRe = /<tr[^>]+data-uid[^>]*>([\s\S]*?)<\/tr>/gi;
  const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
  const stripTags = (s: string) => s.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&amp;/g, '&').trim();
  const parseAmt = (s: string): number | undefined => {
    const n = parseFloat(s.replace(/,/g, ''));
    return !isNaN(n) && n > 0 ? n : undefined;
  };
  const parseDMY = (s: string): string | null => {
    const mm = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(s);
    return mm ? `${mm[3]}-${mm[2]}-${mm[1]}` : null;
  };

  let rm: RegExpExecArray | null;
  while ((rm = rowRe.exec(html)) !== null) {
    const rowHtml = rm[1];
    const cells: string[] = [];
    let cm: RegExpExecArray | null;
    const cellMatcher = new RegExp(cellRe.source, 'gi');
    while ((cm = cellMatcher.exec(rowHtml)) !== null) {
      cells.push(stripTags(cm[1]));
    }
    if (cells.length < 11) continue;
    const transactionDate = parseDMY(cells[0]);
    if (!transactionDate) continue;
    results.push({
      transactionDate,
      reference: cells[2].trim() || undefined,
      description: cells[6].trim() || '—',
      debit: parseAmt(cells[9]),
      credit: parseAmt(cells[10]),
      currency: accountCurrency,
      counterpartyUnp: cells[4].trim() || undefined,
      counterpartyName: cells[3].trim() || undefined,
      counterpartyAccount: cells[5].trim() || undefined,
      operationCode: cells[1].trim() || undefined,
    });
  }
  return results;
}

async function extractFromPageDom(page: Page, req: StatementRequest, accountCurrency: string): Promise<ScrapedTransaction[]> {
  // Strategy 1: JS Model in page scripts
  const modelTx = await extractJsModelFromPage(page, accountCurrency);
  if (modelTx.length > 0) {
    logger.info('[belveb:stmt] Extracted from page JS Model', { count: modelTx.length });
    return modelTx;
  }

  // Strategy 2: Kendo Grid rows in DOM (fixed column positions)
  const gridTx = await extractKendoGridFromPage(page, accountCurrency);
  if (gridTx.length > 0) {
    logger.info('[belveb:stmt] Extracted from page Kendo Grid', { count: gridTx.length });
    return gridTx;
  }

  return [];
}

async function extractJsModelFromPage(page: Page, accountCurrency: string): Promise<ScrapedTransaction[]> {
  // All logic inlined to avoid named inner functions (esbuild adds __name() for named fns,
  // which is undefined in the browser context of page.evaluate)
  try {
    const raw = await page.evaluate(() => {
      const scripts = Array.from(document.querySelectorAll('script'));
      for (let si = 0; si < scripts.length; si++) {
        const src = scripts[si].textContent ?? '';
        if (!src.includes('"Model"') && !src.includes("'Model'")) continue;
        if (!src.includes('DocDate') && !src.includes('Debit') && !src.includes('Credit') &&
            !src.includes('Amount') && !src.includes('TransactionDate')) continue;
        const om = src.match(/,\s*(\{"[\s\S]*?"Model"\s*:\s*\[[\s\S]*?\][\s\S]*?\})\s*\)\s*;/) ??
                   src.match(/new\s+Module\s*\(\s*(\{"[\s\S]*?"Model"\s*:\s*\[[\s\S]*?\][\s\S]*?\})\s*\)/);
        if (!om) continue;
        try { return om[1].replace(/new\s+Date\s*\((\d+)\)/g, '"$1"'); }
        catch { continue; }
      }
      return null;
    });
    if (!raw) return [];
    const data = JSON.parse(raw) as { Model?: unknown[] };
    if (!Array.isArray(data?.Model)) return [];
    return data.Model
      .map((item) => parseApiItem(item as Record<string, unknown>, accountCurrency))
      .filter((t): t is ScrapedTransaction => t !== null);
  } catch {
    return [];
  }
}

async function extractKendoGridFromPage(page: Page, accountCurrency: string): Promise<ScrapedTransaction[]> {
  // Column layout confirmed from thead data-field attributes in Vpsk/List response:
  //  0: DocumentAcceptDate — Дата операции
  //  1: OperationCode      — Код операции
  //  2: DocumentNumber     — № документа
  //  3: CorrespondentName  — Наименование корреспондента
  //  4: Unp               — УНП
  //  5: AccountNumber     — № счёта корреспондента
  //  6: DestinationPayment — Назначение платежа
  //  7: DestinationPaymentKnp — КНП
  //  8: OchPlat           — Очередь
  //  9: DebitAmount       — Дебет  (comma-thousands, dot-decimal: "13,330.97")
  // 10: CreditAmount      — Кредит
  // 11-12: Attachments / AdditionalAction
  try {
    const rowData: string[][] = await page.evaluate(() => {
      const rows = document.querySelectorAll(
        '#vpsk-list-result tr[data-uid], #prtl0 tr[data-uid], tr[data-uid]',
      );
      const out: string[][] = [];
      for (let i = 0; i < rows.length; i++) {
        const tds = rows[i].querySelectorAll('td');
        const cells: string[] = [];
        for (let j = 0; j < tds.length; j++) cells.push(tds[j].textContent?.trim() ?? '');
        out.push(cells);
      }
      return out;
    });

    const parseAmt = (s: string): number | undefined => {
      const n = parseFloat(s.replace(/,/g, ''));
      return !isNaN(n) && n > 0 ? n : undefined;
    };
    const parseDMY = (s: string): string | null => {
      const mm = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(s);
      return mm ? `${mm[3]}-${mm[2]}-${mm[1]}` : null;
    };

    const results: ScrapedTransaction[] = [];
    for (const cells of rowData) {
      if (cells.length < 11) continue;
      const transactionDate = parseDMY(cells[0]);
      if (!transactionDate) continue;
      results.push({
        transactionDate,
        reference: cells[2].trim() || undefined,
        description: cells[6].trim() || '—',
        debit: parseAmt(cells[9]),
        credit: parseAmt(cells[10]),
        currency: accountCurrency,
        counterpartyUnp: cells[4].trim() || undefined,
        counterpartyName: cells[3].trim() || undefined,
        counterpartyAccount: cells[5].trim() || undefined,
        operationCode: cells[1].trim() || undefined,
      });
    }
    return results;
  } catch {
    return [];
  }
}

// ── Node.js-side transaction item parser ─────────────────────────────────────

function parseApiItem(t: Record<string, unknown>, accountCurrency: string): ScrapedTransaction | null {
  const rawDate = strPick(t, [
    'DocumentAcceptDate', 'DocDate', 'docDate', 'TransactionDate', 'transactionDate',
    'OperationDate', 'operationDate', 'Date', 'date', 'ValueDate', 'valueDate', 'PostingDate',
  ]);
  const transactionDate = parseDate(rawDate);
  if (!transactionDate) return null;

  const debitAmount = numPick(t, ['DebitAmount', 'Debit', 'debit', 'debitAmount']);
  const creditAmount = numPick(t, ['CreditAmount', 'Credit', 'credit', 'creditAmount']);
  const amount = numPick(t, ['Amount', 'amount', 'Sum', 'sum', 'DocSum', 'docSum']);

  let debit: number | undefined;
  let credit: number | undefined;
  if (debitAmount !== null && debitAmount > 0) debit = debitAmount;
  else if (creditAmount !== null && creditAmount > 0) credit = creditAmount;
  else if (amount !== null && amount !== 0) {
    if (amount < 0) debit = Math.abs(amount);
    else credit = amount;
  }

  return {
    transactionDate,
    reference: strPick(t, ['DocumentNumber', 'DocNumber', 'docNumber', 'Reference', 'reference', 'Id', 'id']) || undefined,
    description: strPick(t, ['DestinationPayment', 'PaymentPurpose', 'paymentPurpose', 'Purpose', 'purpose', 'Description', 'description', 'Narrative', 'narrative', 'Details', 'details', 'Comment', 'comment']) || '—',
    debit,
    credit,
    currency: strPick(t, ['CurrencyText', 'currencyText', 'Currency', 'currency', 'Ccy', 'ccy']) || accountCurrency,
    counterpartyUnp: strPick(t, ['Unp', 'unp', 'CounterpartyUnp', 'counterpartyUnp', 'PayerUnp', 'payerUnp']) || undefined,
    counterpartyName: strPick(t, ['CorrespondentName', 'CounterpartyName', 'counterpartyName', 'Contractor', 'contractor', 'PayerName', 'payerName', 'PayeeName', 'payeeName']) || undefined,
    counterpartyAccount: strPick(t, ['AccountNumber', 'accountNumber', 'CorrespondentAccount', 'correspondentAccount', 'CounterpartyAccount', 'counterpartyAccount']) || undefined,
    operationCode: strPick(t, ['OperationCode', 'operationCode', 'OpCode', 'opCode', 'TransactionCode', 'transactionCode']) || undefined,
  };
}

