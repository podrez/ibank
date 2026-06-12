import { Page } from 'playwright';
import { ScrapedAccount } from '../types';
import { logger } from '../../logger';
import fs from 'fs';
import { getConfig } from '../../config/store';

/**
 * Scrape account balances from the BelVEB DBO Cabinet.
 *
 * The accounts widget at /Bia.Portlets.Ib.BelVEB.Accounts.Widget/AccountsWidget/Index
 * is loaded asynchronously as HTML. It renders a Kendo Grid with account rows
 * (tr[data-uid]) and embeds the full Model array in a JS require() call.
 *
 * Strategy 1: read the Model array from the embedded JS initialization code.
 * Strategy 2: read Kendo Grid rows from the DOM (same cells structure).
 */
const CABINET_URL = 'https://dbo2.bveb.by/Cabinet/';

export async function scrapeAccounts(page: Page): Promise<ScrapedAccount[]> {
  const url = page.url();
  // Check for EXACTLY the cabinet dashboard (not sub-pages like /Accounts/Vpsk/...).
  // /Cabinet/ sub-pages (e.g. after statement scraping) don't have the accounts widget.
  const onDashboard = /\/Cabinet\/?(\?.*)?$/.test(url);
  if (!onDashboard) {
    logger.info('[belveb] Not on cabinet dashboard, navigating', { url });
    await page.goto(CABINET_URL, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    await page.waitForTimeout(1_500);

    // BelVEB session may redirect /Cabinet/ back to the last visited portlet sub-page.
    // If that happened, navigate once more to break out of the server-side redirect.
    const urlAfterNav = page.url();
    if (!/\/Cabinet\/?(\?.*)?$/.test(urlAfterNav)) {
      logger.warn('[belveb] Cabinet navigation redirected to sub-page, retrying', { urlAfterNav });
      await page.goto(CABINET_URL, { waitUntil: 'load', timeout: 25_000 });
      await page.waitForTimeout(2_000);
    }
  }
  if (!page.url().includes('/Cabinet/')) {
    throw new Error('[belveb] scrapeAccounts: session expired, redirected away from Cabinet');
  }

  logger.info('[belveb] Scraping account balances', { url: page.url() });

  // Wait for the accounts widget to finish loading (async portlet)
  // The grid rows (tr[data-uid]) appear once the AccountsWidget portlet has rendered.
  logger.info('[belveb] Waiting for accounts widget to load...');
  await page.waitForSelector(
    '.accounts-widget tr[data-uid], [data-widget="accounts"] tr[data-uid], #prtl0 tr[data-uid]',
    { timeout: 20_000 },
  ).catch(() => null);

  if (getConfig('DEBUG_SCREENSHOTS') === 'true') {
    const dir = './data/debug';
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(`${dir}/belveb-dashboard.html`, await page.content());
    await page.screenshot({ path: `${dir}/belveb-dashboard.png`, fullPage: true }).catch(() => null);
    logger.info('[belveb] Dashboard snapshot saved to ./data/debug/');
  }

  // Strategy 1: extract Model array from embedded JS initialization
  const modelAccounts = await extractFromJsModel(page);
  if (modelAccounts && modelAccounts.length > 0) {
    logger.info('[belveb] Accounts extracted from JS Model', { count: modelAccounts.length });
    return modelAccounts;
  }

  // Strategy 2: read Kendo Grid rows from DOM
  logger.info('[belveb] Falling back to Kendo Grid DOM scraping');
  const gridAccounts = await extractFromKendoGrid(page);
  if (gridAccounts && gridAccounts.length > 0) {
    logger.info('[belveb] Accounts extracted from Kendo Grid', { count: gridAccounts.length });
    return gridAccounts;
  }

  // Strategy 3: BelVEB session may have loaded the last-visited portlet (e.g. Vpsk) instead
  // of the accounts widget. Fetch the accounts portlet directly via AJAX — this uses the
  // existing browser session cookies and bypasses the "active portlet" session state.
  logger.info('[belveb] Falling back to direct accounts portlet fetch');
  const portletAccounts = await extractFromDirectPortletFetch(page);
  if (portletAccounts && portletAccounts.length > 0) {
    logger.info('[belveb] Accounts extracted from direct portlet fetch', { count: portletAccounts.length });
    return portletAccounts;
  }

  throw new Error(
    '[belveb] Could not find account data on the dashboard. ' +
    'Set DEBUG_SCREENSHOTS=true and inspect ./data/debug/belveb-dashboard.html.',
  );
}

// ── Strategy 3: direct AJAX fetch of accounts portlet ────────────────────────

async function extractFromDirectPortletFetch(page: Page): Promise<ScrapedAccount[] | null> {
  // The accounts widget is loaded as an async portlet at this endpoint.
  // Fetching it directly with the current session cookies bypasses the BelVEB
  // "last active portlet" session state that otherwise shows the Vpsk portlet on /Cabinet/.
  const PORTLET_URL = '/Bia.Portlets.Ib.BelVEB.Accounts.Widget/AccountsWidget/Index';
  try {
    const html = await page.evaluate(async (url: string) => {
      try {
        const res = await fetch(url, {
          method: 'GET',
          headers: { 'X-Requested-With': 'XMLHttpRequest', 'Accept': 'text/html' },
          credentials: 'same-origin',
        });
        return res.ok ? await res.text() : null;
      } catch { return null; }
    }, PORTLET_URL);

    if (!html || html.length < 100) return null;
    return parseAccountsFromPortletHtml(html);
  } catch {
    return null;
  }
}

function parseAccountsFromPortletHtml(html: string): ScrapedAccount[] | null {
  // The portlet returns HTML with the same IIFE pattern as the main cabinet page:
  //   (function(moduleName, settings){...})('accounts.widget.index', {Model:[...]});
  const match = html.match(/accounts\.widget\.index['"]\s*,\s*(\{[\s\S]+?\})\s*\)\s*;/) ??
                html.match(/accounts\.widget\.index['"]\s*,\s*(\{[\s\S]+\})\s*\)\s*;/);
  if (!match) return null;

  try {
    const cleaned = match[1].replace(/new\s+Date\s*\((\d+)\)/g, '$1');
    const data = JSON.parse(cleaned) as {
      Model?: Array<{
        AccountNumber: string;
        Name?: string;
        AvailableBalance: number;
        CurrencyText: string;
      }>;
    };
    if (!Array.isArray(data?.Model) || data.Model.length === 0) return null;

    return data.Model.map((a) => ({
      accountNumber: a.AccountNumber,
      currency: a.CurrencyText,
      name: a.Name || a.AccountNumber,
      balance: a.AvailableBalance,
      available: a.AvailableBalance,
    }));
  } catch {
    return null;
  }
}

// ── Strategy 1: extract from embedded JS Model ────────────────────────────────

async function extractFromJsModel(page: Page): Promise<ScrapedAccount[] | null> {
  try {
    return await page.evaluate(() => {
      // The AccountsWidget embeds its data as a JSON Model inside a require() call:
      // require(['bia.portlets.ib.belveb.accounts.widget.index'], function(Module) {
      //   new Module({"Model":[{AccountNumber, Name, AvailableBalance, CurrencyText, ...}], ...});
      // });
      const scripts = Array.from(document.querySelectorAll('script'));
      for (const script of scripts) {
        const src = script.textContent ?? '';
        if (!src.includes('accounts.widget.index') && !src.includes('AccountsWidget')) continue;

        // The widget uses an IIFE pattern:
        //   (function(moduleName, moduleSettings){...})('...accounts.widget.index', {"Model":[...],...});
        // The JSON data is the SECOND argument to the IIFE, after the module name string.
        const match = src.match(/accounts\.widget\.index['"]\s*,\s*(\{[\s\S]+?\})\s*\)\s*;/) ??
                      src.match(/accounts\.widget\.index['"]\s*,\s*(\{[\s\S]+\})\s*\)\s*;/);
        if (!match) continue;

        try {
          // The JSON may contain `new Date(...)` literals — strip them to plain numbers
          const cleaned = match[1].replace(/new\s+Date\s*\((\d+)\)/g, '$1');
          const data = JSON.parse(cleaned) as {
            Model?: Array<{
              AccountNumber: string;
              Name?: string;
              AvailableBalance: number;
              CurrencyText: string;
            }>;
          };
          if (!Array.isArray(data?.Model) || data.Model.length === 0) continue;

          return data.Model.map((a) => ({
            accountNumber: a.AccountNumber,
            currency: a.CurrencyText,
            name: a.Name || a.AccountNumber,
            balance: a.AvailableBalance,
            available: a.AvailableBalance,
          }));
        } catch { continue; }
      }
      return null;
    });
  } catch {
    return null;
  }
}

// ── Strategy 2: Kendo Grid row scraping ───────────────────────────────────────

async function extractFromKendoGrid(page: Page): Promise<ScrapedAccount[] | null> {
  try {
    return await page.evaluate(() => {
      // Column layout (from GridDefinitions in the widget HTML):
      //   0: IsSelected (hidden)  1: AccountNumber  2: Name
      //   3: AvailableBalance     4: CurrencyText   5: LastTransactionDate
      const rows = Array.from(document.querySelectorAll(
        '.accounts-widget tr[data-uid], [data-widget="accounts"] tr[data-uid], #prtl0 tr[data-uid]',
      ));
      if (rows.length === 0) return null;

      const results: Array<{
        accountNumber: string;
        currency: string;
        name: string;
        balance: number;
        available: number | null;
      }> = [];

      for (const row of rows) {
        const cells = Array.from(row.querySelectorAll('td'));
        // cells[0] is hidden (IsSelected); skip it
        const accountNumber = cells[1]?.textContent?.trim() ?? '';
        const name = cells[2]?.textContent?.trim() ?? '';
        const balanceRaw = cells[3]?.textContent?.trim() ?? '';
        const currency = cells[4]?.textContent?.trim() ?? '';

        if (!accountNumber || !currency) continue;

        // Balance may be formatted as "76 597,24" or "76 597.24"
        const balance = parseFloat(
          balanceRaw.replace(/\s/g, '').replace(',', '.'),
        );
        if (isNaN(balance)) continue;

        results.push({
          accountNumber,
          currency,
          name: name || accountNumber,
          balance,
          available: balance,
        });
      }
      return results.length > 0 ? results : null;
    });
  } catch {
    return null;
  }
}
