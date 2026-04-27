import { Page } from 'playwright';
import { ScrapedTransaction, StatementRequest } from '../types';
import { logger } from '../../logger';
import fs from 'fs';
import path from 'path';

const BASE_URL = 'https://online.alfabank.by';
const DASHBOARD_URL = `${BASE_URL}/Cabinet/Dashboard/`;
const DEBUG_DIR = './data/debug';

/**
 * Scrape statement for a given Alfa-Bank account.
 * Navigates to the "Выписки" section (not dashboard movement widgets)
 * because only that section exposes counterparty UNP.
 *
 * Strategy 1: API intercept — catch the XHR with transaction JSON.
 * Strategy 2: DOM scraping of the rendered statement table.
 */
export async function scrapeStatement(
  page: Page,
  req: StatementRequest,
): Promise<ScrapedTransaction[]> {
  logger.info('[alfabank:statement] ═══ Starting statement scrape ═══', {
    account: req.accountNumber,
    from: req.dateFrom,
    to: req.dateTo,
  });

  const saveSnap = async (name: string) => {
    if (process.env.DEBUG_SCREENSHOTS !== 'true') return;
    try {
      if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });
      const safe = req.accountNumber.replace(/[^A-Z0-9]/gi, '_');
      const file = `alfabank-stmt-${safe}-${name}`;
      await page.screenshot({ path: path.join(DEBUG_DIR, `${file}.png`), fullPage: true }).catch(() => null);
      fs.writeFileSync(path.join(DEBUG_DIR, `${file}.html`), await page.content().catch(() => ''));
      logger.info(`[alfabank:statement] Snapshot saved: ./data/debug/${file}.png`);
    } catch { /* ignore */ }
  };

  // Step 1: navigate to the Выписки section
  logger.info('[alfabank:statement] Step 1: Navigating to Выписки section');
  const landed = await navigateToStatements(page);
  logger.info('[alfabank:statement] Step 1 result', { landed });
  await saveSnap('01-statements-page');

  if (!landed) {
    logger.error('[alfabank:statement] Could not reach Выписки section');
    return [];
  }

  // Step 2: click "Изменить" to open the request form
  logger.info('[alfabank:statement] Step 2: Clicking Изменить to open request form');
  await clickIzmenit(page);
  await page.waitForTimeout(1_000);
  await saveSnap('02-after-izmenit');

  // Step 3: select the account
  logger.info('[alfabank:statement] Step 3: Selecting account', { account: req.accountNumber });
  const accountSelected = await selectAccount(page, req.accountNumber);
  logger.info('[alfabank:statement] Step 3 result', { accountSelected });
  await page.waitForTimeout(1_000);
  await saveSnap('03-account-selected');

  // Step 4: fill date range
  logger.info('[alfabank:statement] Step 4: Filling date range', { from: req.dateFrom, to: req.dateTo });
  await fillDateRange(page, req.dateFrom, req.dateTo);
  await saveSnap('04-dates-filled');

  // Step 5: submit and intercept API response or fall back to DOM
  logger.info('[alfabank:statement] Step 5: Submitting and waiting for data');
  const transactions = await submitAndCollect(page, req);
  logger.info('[alfabank:statement] Step 5 result', { count: transactions.length });
  await saveSnap('05-after-submit');

  return transactions;
}

// ── Step 1: Navigate to Выписки ───────────────────────────────────────────────

async function navigateToStatements(page: Page): Promise<boolean> {
  const STATEMENTS_URL = `${BASE_URL}/Cabinet/Statements/`;

  // Direct navigation — confirmed URL from page HTML
  try {
    await page.goto(STATEMENTS_URL, { waitUntil: 'domcontentloaded', timeout: 15_000 });
    await page.waitForTimeout(1_500);
    const current = page.url();
    if (current.includes('/Statements')) {
      logger.info('[alfabank:statement] Reached Выписки via direct URL', { url: current });
      return true;
    }
    logger.info('[alfabank:statement] Direct URL redirected away', { from: STATEMENTS_URL, to: current });
  } catch (err) {
    logger.warn('[alfabank:statement] Direct navigation failed', { error: (err as Error).message });
  }

  // Fall back: click the nav link from the dashboard
  logger.info('[alfabank:statement] Falling back to menu click');
  if (!page.url().includes('/Cabinet/')) {
    try {
      await page.goto(DASHBOARD_URL, { waitUntil: 'networkidle', timeout: 20_000 });
      await page.waitForTimeout(1_500);
    } catch {
      logger.warn('[alfabank:statement] Could not load dashboard');
      return false;
    }
  }

  const link = page.locator(`a[href="/Cabinet/Statements/"]`).first();
  if (await link.isVisible({ timeout: 3_000 }).catch(() => false)) {
    logger.info('[alfabank:statement] Clicking nav link /Cabinet/Statements/');
    await link.click();
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1_000);
    const current = page.url();
    if (current.includes('/Statements')) {
      logger.info('[alfabank:statement] Reached Выписки via menu click', { url: current });
      return true;
    }
    logger.warn('[alfabank:statement] Click did not navigate to Statements', { url: current });
  } else {
    logger.warn('[alfabank:statement] Nav link a[href="/Cabinet/Statements/"] not visible');
  }

  return false;
}

// ── Step 2: Click "Изменить" ──────────────────────────────────────────────────

async function clickIzmenit(page: Page): Promise<void> {
  const selectors = [
    'button:has-text("Изменить")',
    'a:has-text("Изменить")',
    '[class*="edit"]:has-text("Изменить")',
  ];
  for (const sel of selectors) {
    const btn = page.locator(sel).first();
    if (await btn.isVisible({ timeout: 3_000 }).catch(() => false)) {
      logger.info(`[alfabank:statement] Clicking Изменить (${sel})`);
      await btn.click();
      await page.waitForLoadState('networkidle').catch(() => null);
      return;
    }
  }
  logger.warn('[alfabank:statement] "Изменить" button not found — proceeding anyway');
}

// ── Step 3: Select account ────────────────────────────────────────────────────

async function selectAccount(page: Page, accountNumber: string): Promise<boolean> {
  // Use Kendo MultiSelect JS API — the native select is hidden, interact via kendo widget
  const ok = await page.evaluate(function(accNum) {
    var $ = (window as any).jQuery;
    if (!$) return false;
    var w = $('select[name="SelectedAccountNumbers"]').data('kendoMultiSelect');
    if (!w) return false;
    w.value([accNum]);
    w.trigger('change');
    return true;
  }, accountNumber);

  if (ok) {
    logger.info(`[alfabank:statement] Account set via Kendo MultiSelect API: ${accountNumber}`);
    await page.waitForTimeout(300);
    return true;
  }

  // Fallback: DOM click — remove wrong tags, click correct option in dropdown list
  // Remove any selected tags that don't match our account
  const tags = await page.locator('#SelectedAccountNumbers_taglist li.k-button').all();
  for (const tag of tags) {
    const acc = await tag.locator('[acc]').getAttribute('acc').catch(() => '');
    if (acc && acc !== accountNumber) {
      await tag.locator('.k-i-close').click().catch(() => null);
      await page.waitForTimeout(200);
    }
  }

  // Check if target is already selected
  const alreadySelected = await page
    .locator(`#SelectedAccountNumbers_taglist [acc="${accountNumber}"]`)
    .isVisible({ timeout: 500 })
    .catch(() => false);
  if (alreadySelected) {
    logger.info(`[alfabank:statement] Account already selected: ${accountNumber}`);
    return true;
  }

  // Open dropdown and click the target option
  await page.locator('input.k-input[aria-owns*="SelectedAccountNumbers"]').first().click();
  await page.waitForTimeout(500);
  const opt = page.locator(`#SelectedAccountNumbers_listbox [acc="${accountNumber}"]`).first();
  if (await opt.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await opt.click();
    logger.info(`[alfabank:statement] Account selected via dropdown click: ${accountNumber}`);
    return true;
  }

  logger.warn('[alfabank:statement] Could not select account — proceeding anyway');
  return false;
}

// ── Step 4: Fill date range ───────────────────────────────────────────────────

async function fillDateRange(page: Page, dateFrom: string, dateTo: string): Promise<void> {
  // Select "Период" from the dropdown — UI click is the primary approach
  logger.info('[alfabank:statement] Selecting "Период" from Period dropdown');
  await selectPeriodViaClick(page);

  // Wait for IsPeriodSelectionVisible binding to show the date inputs
  const dateFromVisible = await page
    .locator('input[name="DateFrom"]')
    .waitFor({ state: 'visible', timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
  logger.info(`[alfabank:statement] DateFrom input visible after Period selection: ${dateFromVisible}`);

  if (!dateFromVisible) {
    // Fallback: try Kendo JS API
    logger.info('[alfabank:statement] UI click did not reveal date inputs, trying Kendo JS API');
    await page.evaluate(function() {
      var $ = (window as any).jQuery;
      if (!$) return;
      var w = $('input[name="Period"]').data('kendoDropDownList');
      if (!w) return;
      w.value('Period');
      w.trigger('change');
    });
    await page.locator('input[name="DateFrom"]')
      .waitFor({ state: 'visible', timeout: 3_000 })
      .catch(() => null);
  }

  // Set DateFrom and DateTo via Kendo DatePicker JS API
  const [fy, fm, fd] = dateFrom.split('-');
  const [ty, tm, td] = dateTo.split('-');
  const datesSet = await page.evaluate(function(args: { fy: number; fm: number; fd: number; ty: number; tm: number; td: number }) {
    var elFrom = document.querySelector('input[name="DateFrom"]');
    var elTo   = document.querySelector('input[name="DateTo"]');
    if (!elFrom || !elTo) return false;
    var $ = (window as any).jQuery;
    if (!$) return false;
    var wFrom = $(elFrom).data('kendoDatePicker');
    var wTo   = $(elTo).data('kendoDatePicker');
    if (!wFrom || !wTo) return false;
    wFrom.value(new Date(args.fy, args.fm - 1, args.fd));
    wFrom.trigger('change');
    wTo.value(new Date(args.ty, args.tm - 1, args.td));
    wTo.trigger('change');
    return true;
  }, { fy: +fy, fm: +fm, fd: +fd, ty: +ty, tm: +tm, td: +td });
  logger.info(`[alfabank:statement] Dates set via Kendo API: ${datesSet}`);

  if (!datesSet) {
    // Fallback: type digits into the masked inputs
    await fillMaskedDate(page, 'input[name="DateFrom"]', dateFrom, 'DateFrom');
    await fillMaskedDate(page, 'input[name="DateTo"]',   dateTo,   'DateTo');
  }

  const fromVal = await page.locator('input[name="DateFrom"]').inputValue().catch(() => '?');
  const toVal   = await page.locator('input[name="DateTo"]').inputValue().catch(() => '?');
  logger.info(`[alfabank:statement] Date inputs after fill: DateFrom="${fromVal}", DateTo="${toVal}"`);
}

async function selectPeriodViaClick(page: Page): Promise<void> {
  // Strategy 1: set Knockout observable directly via ko.dataFor()
  // This walks up from input[name="Period"] to find the KO ViewModel and sets Period('Period'),
  // which cascades to IsPeriodSelectionVisible and makes the date inputs appear.
  const koSet = await page.evaluate(function() {
    var input = document.querySelector('input[name="Period"]');
    if (!input) return 'no-input';
    var el: Element | null = input;
    while (el) {
      var vm = (window as any).ko && (window as any).ko.dataFor(el);
      if (vm && typeof (vm as any).Period === 'function') {
        (vm as any).Period('Period');
        return 'ok';
      }
      el = el.parentElement;
    }
    return 'no-vm';
  });
  logger.info(`[alfabank:statement] Period set via ko.dataFor: ${koSet}`);
  if (koSet === 'ok') return;

  // Strategy 2: jQuery DDL .select() + DOM change event for Knockout
  const jqSet = await page.evaluate(function() {
    var $ = (window as any).jQuery;
    if (!$) return 'no-jquery';
    var ddl = $('input[name="Period"]').data('kendoDropDownList');
    if (!ddl) return 'no-ddl';
    ddl.select(function(item: any) { return item.Value === 'Period'; });
    ddl.trigger('change');
    var el = $('input[name="Period"]')[0] as HTMLElement;
    if (el) el.dispatchEvent(new Event('change', { bubbles: true }));
    return 'ok';
  });
  logger.info(`[alfabank:statement] Period set via jQuery DDL: ${jqSet}`);
}

async function fillMaskedDate(page: Page, selector: string, isoDate: string, label: string): Promise<void> {
  const el = page.locator(selector).first();
  if (!await el.isVisible({ timeout: 2_000 }).catch(() => false)) {
    logger.warn(`[alfabank:statement] ${label} input not visible`);
    return;
  }
  const [yyyy, mm, dd] = isoDate.split('-');
  const digits = `${dd}${mm}${yyyy}`;
  logger.info(`[alfabank:statement] ${label}: "${isoDate}" → digits "${digits}"`);
  await el.click();
  await page.waitForTimeout(100);
  await page.keyboard.press('Home');
  await page.waitForTimeout(50);
  for (const ch of digits) {
    await page.keyboard.press(ch);
    await page.waitForTimeout(40);
  }
  const val = await el.inputValue().catch(() => '?');
  logger.info(`[alfabank:statement] ${label} value after fill: "${val}"`);
}

// ── Step 5: Submit and collect transactions ───────────────────────────────────

async function submitAndCollect(page: Page, req: StatementRequest): Promise<ScrapedTransaction[]> {
  // The form POSTs to /Bia.Portlets.Ib.Alfa.Statements/Statements/List and
  // injects the HTML response into [data-element-id="statements-list-result"].
  // Intercept JSON if available; otherwise parse the rendered HTML.
  const intercepted = await new Promise<ScrapedTransaction[] | null>((resolve) => {
    const timer = setTimeout(() => {
      page.removeAllListeners('response');
      resolve(null);
    }, 30_000);

    page.on('response', async (response) => {
      if (!response.ok()) return;
      const url = response.url();
      if (!url.includes('Statements/List') && !url.includes('statements/list')) return;
      const ct = response.headers()['content-type'] ?? '';
      if (!ct.includes('json')) {
        // HTML partial — resolve null and let DOM scraping handle it
        clearTimeout(timer);
        page.removeAllListeners('response');
        resolve(null);
        return;
      }
      try {
        const json = await response.json();
        const txs = parseApiResponse(json);
        if (txs && txs.length > 0) {
          clearTimeout(timer);
          page.removeAllListeners('response');
          resolve(txs);
        }
      } catch { /* ignore */ }
    });

    clickSubmitButton(page).catch(() => resolve(null));
  });

  if (intercepted && intercepted.length > 0) {
    logger.info('[alfabank:statement] Got transactions via API intercept', { count: intercepted.length });
    return intercepted;
  }

  // Wait for the partial-HTML result container to update
  await page.waitForLoadState('networkidle').catch(() => null);
  // The form POSTs and the result lands in [data-element-id="statements-list-result"]
  // Wait until the loading indicator is gone or statement content appears
  await page.waitForSelector(
    '[data-element-id="statements-list-result"] .statements-list__panelbar, ' +
    '[data-element-id="statements-list-result"] table, ' +
    '[data-element-id="statements-list-result"] .empty-result',
    { timeout: 15_000 },
  ).catch(() => null);
  await page.waitForTimeout(1_000);

  logger.info('[alfabank:statement] Parsing transactions from rendered DOM');
  return domScrape(page, req);
}

async function clickSubmitButton(page: Page): Promise<void> {
  // Confirmed selector from page HTML: button[type="submit"] inside .actions div
  const btn = page.locator('.actions button[type="submit"]').first();
  if (await btn.isVisible({ timeout: 3_000 }).catch(() => false)) {
    const text = await btn.innerText().catch(() => 'submit');
    logger.info(`[alfabank:statement] Clicking submit: "${text.trim()}"`);
    await btn.click();
    return;
  }
  // Fallback
  for (const sel of ['button:has-text("Применить")', 'button[type="submit"]']) {
    const fb = page.locator(sel).first();
    if (await fb.isVisible({ timeout: 1_000 }).catch(() => false)) {
      logger.info(`[alfabank:statement] Clicking submit (fallback): ${sel}`);
      await fb.click();
      return;
    }
  }
  logger.warn('[alfabank:statement] No submit button found');
}

// ── API response parser ───────────────────────────────────────────────────────

function parseApiResponse(json: unknown): ScrapedTransaction[] | null {
  if (!json || typeof json !== 'object') return null;

  let list: unknown[] | null = null;
  if (Array.isArray(json)) {
    list = json;
  } else {
    const obj = json as Record<string, unknown>;
    for (const key of [
      'transactions', 'Transactions', 'operations', 'Operations',
      'movements', 'Movements', 'history', 'History',
      'items', 'Items', 'data', 'Data', 'result', 'Result',
      'statement', 'Statement',
    ]) {
      if (Array.isArray(obj[key])) { list = obj[key] as unknown[]; break; }
    }
  }

  if (!list || list.length === 0) return null;

  const result: ScrapedTransaction[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const tx = parseTxItem(item as Record<string, unknown>);
    if (tx) result.push(tx);
  }

  return result.length > 0 ? result : null;
}

function parseTxItem(a: Record<string, unknown>): ScrapedTransaction | null {
  const transactionDate = parseDate(str(a, [
    'transactionDate', 'TransactionDate', 'date', 'Date',
    'operationDate', 'OperationDate', 'valueDate', 'ValueDate',
    'created_at', 'createdAt',
  ]));
  if (!transactionDate) return null;

  const currency = str(a, [
    'currency', 'Currency', 'currencyCode', 'CurrencyCode', 'iso', 'Iso',
  ]);
  if (!currency) return null;

  const description = str(a, [
    'description', 'Description', 'purpose', 'Purpose',
    'details', 'Details', 'narrative', 'Narrative',
    'comment', 'Comment', 'memo', 'Memo',
    'operationName', 'OperationName', 'name', 'Name',
  ]);

  const reference = str(a, [
    'reference', 'Reference', 'documentNumber', 'DocumentNumber',
    'docNumber', 'DocNumber', 'id', 'Id',
    'operationId', 'OperationId', 'transactionId', 'TransactionId',
  ]) || undefined;

  const counterpartyUnp = str(a, [
    'unp', 'Unp', 'UNP',
    'counterpartyUnp', 'CounterpartyUnp',
    'taxpayerId', 'TaxpayerId',
    'beneficiaryUnp', 'BeneficiaryUnp',
    'inn', 'Inn',
  ]) || undefined;

  const counterpartyName = str(a, [
    'correspondentName', 'CorrespondentName',
    'counterpartyName', 'CounterpartyName',
    'beneficiaryName', 'BeneficiaryName',
    'payerName', 'PayerName',
    'counterparty', 'Counterparty',
    'contractor', 'Contractor',
  ]) || undefined;

  const amount = num(a, ['amount', 'Amount', 'sum', 'Sum']);
  const debitRaw  = numOrNull(a, ['debit', 'Debit', 'debitAmount', 'DebitAmount', 'expense', 'Expense']);
  const creditRaw = numOrNull(a, ['credit', 'Credit', 'creditAmount', 'CreditAmount', 'income', 'Income']);

  let debit: number | undefined;
  let credit: number | undefined;

  if (debitRaw !== null && debitRaw !== 0) {
    debit = Math.abs(debitRaw);
  } else if (creditRaw !== null && creditRaw !== 0) {
    credit = Math.abs(creditRaw);
  } else if (amount !== null) {
    const typeStr = str(a, ['type', 'Type', 'direction', 'Direction', 'operationType', 'OperationType']);
    const isDebit = amount < 0 || /debit|expense|out|расход|дебет/i.test(typeStr);
    if (isDebit) { debit = Math.abs(amount); } else { credit = Math.abs(amount); }
  }

  if (debit === undefined && credit === undefined) return null;
  return { transactionDate, reference, description, debit, credit, currency, counterpartyUnp, counterpartyName };
}

// ── DOM scraping fallback ─────────────────────────────────────────────────────

interface AlfaBankTurn {
  AcceptDateText: string;
  DocumentNumber: string;
  Destination: string;
  CorrespondentName: string;
  Amount: number;
  AmountType: number; // 1 = credit (incoming), 0 = debit (outgoing)
  CurrencyIso: string;
  CorrespondentUnp: string;
  Person3Unp: string;
}

async function domScrape(page: Page, req: StatementRequest): Promise<ScrapedTransaction[]> {
  await page.waitForLoadState('networkidle').catch(() => null);
  await page.waitForTimeout(1_000);

  if (process.env.DEBUG_SCREENSHOTS === 'true') {
    if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });
    const safe = req.accountNumber.replace(/[^A-Z0-9]/gi, '_');
    fs.writeFileSync(path.join(DEBUG_DIR, `alfabank-statement-${safe}.html`), await page.content());
    await page.screenshot({ path: path.join(DEBUG_DIR, `alfabank-statement-${safe}.png`), fullPage: true }).catch(() => null);
    logger.info('[alfabank:statement] Snapshot saved to ./data/debug/');
  }

  // Primary strategy: extract from the injected viewModel JS variable.
  // After submit, Alfa-Bank injects a script:
  //   var viewModel<ID>Js = { "Info": { "AccountNumber": "BY...", ... }, "Turns": [...] };
  // Turns contains all transaction data including CorrespondentUnp.
  const turns = await page.evaluate(function() {
    var keys = Object.getOwnPropertyNames(window);
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      if (key.indexOf('viewModel') !== 0) continue;
      try {
        var val = (window as any)[key];
        if (val && typeof val === 'object' && val.Info && val.Info.AccountNumber && Array.isArray(val.Turns)) {
          return val.Turns;
        }
      } catch (e) { /* skip */ }
    }
    return null;
  }) as AlfaBankTurn[] | null;

  if (turns !== null) {
    logger.info(`[alfabank:statement] viewModel Turns: ${turns.length} transaction(s)`);
    return parseTurns(turns, currencyFromAccount(req.accountNumber));
  }

  logger.warn(
    '[alfabank:statement] viewModel not found — statement may not have loaded. ' +
    'Set DEBUG_SCREENSHOTS=true and inspect ./data/debug/alfabank-statement-*.html',
  );
  return [];
}

function parseTurns(turns: AlfaBankTurn[], fallbackCurrency: string): ScrapedTransaction[] {
  const transactions: ScrapedTransaction[] = [];
  let skipped = 0;

  for (const t of turns) {
    const dm = (t.AcceptDateText || '').match(/(\d{2})\.(\d{2})\.(\d{4})/);
    if (!dm) { skipped++; continue; }
    const transactionDate = `${dm[3]}-${dm[2]}-${dm[1]}`;

    const amount = t.Amount ?? 0;
    if (amount === 0) { skipped++; continue; }

    const isCredit = t.AmountType === 1;
    const unp = t.CorrespondentUnp || t.Person3Unp || undefined;

    transactions.push({
      transactionDate,
      reference:        t.DocumentNumber    || undefined,
      description:      t.Destination       || '',
      debit:            isCredit ? undefined : Math.abs(amount),
      credit:           isCredit ? Math.abs(amount) : undefined,
      currency:         t.CurrencyIso        || fallbackCurrency,
      counterpartyUnp:  unp                  || undefined,
      counterpartyName: t.CorrespondentName  || undefined,
    });
  }

  logger.info(
    `[alfabank:statement] parseTurns: ${transactions.length} transactions, ${skipped} skipped`,
  );
  return transactions;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function currencyFromAccount(accountNumber: string): string {
  const map: Record<string, string> = {
    '933': 'BYN', '978': 'EUR', '840': 'USD', '643': 'RUB', '156': 'CNY',
  };
  return map[accountNumber.slice(-3)] ?? 'BYN';
}

function parseDate(raw: string): string | null {
  if (!raw) return null;
  const isoMatch = raw.match(/(\d{4}-\d{2}-\d{2})/);
  if (isoMatch) return isoMatch[1];
  const dotMatch = raw.match(/(\d{2})\.(\d{2})\.(\d{4})/);
  if (dotMatch) return `${dotMatch[3]}-${dotMatch[2]}-${dotMatch[1]}`;
  return null;
}

function str(obj: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) if (obj[k] != null) return String(obj[k]);
  return '';
}

function num(obj: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const v = parseFloat(String(obj[k] ?? ''));
    if (!isNaN(v)) return v;
  }
  return null;
}

function numOrNull(obj: Record<string, unknown>, keys: string[]): number | null {
  return num(obj, keys);
}
