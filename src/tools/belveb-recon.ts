/**
 * Этап 0 ТЗ docs/tz-belveb-intraday.md — разведка кабинета БелВЭБа.
 *
 * Ищет, где dbo2.bveb.by показывает операции ТЕКУЩЕГО дня. Ничего не пишет в базу,
 * в банке только читает страницы. Результат — ./data/debug/belveb-recon/.
 *
 *   docker compose exec <service> node dist/tools/belveb-recon.js BY00BELV...
 *   npx tsx src/tools/belveb-recon.ts BY00BELV...            (локально)
 *
 * Учётные данные берутся так же, как у сервиса: settings в базе (DB_PATH) → .env.
 * Сохраняются HTML страниц, ответы XHR и список запросов (метод, URL, статус).
 * Cookie, заголовки и тела запросов НЕ сохраняются; запись сети включается после входа.
 * Отдельный вход может выбить сессию работающего сервиса — он перелогинится сам
 * на следующем цикле. Удобнее запускать вне окна опроса (после 17:00 Минска).
 * После анализа удалить каталог: rm -rf data/debug/belveb-recon
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { Page, Response } from 'playwright';
import { initConfigStore } from '../config/store';
import { login } from '../banks/belveb/auth';
import { closeBrowser } from '../scraper/browser';
import { isoToDMY } from '../utils/dates';

const BASE_URL = 'https://dbo2.bveb.by';
const OUT_DIR = './data/debug/belveb-recon';
const CURRENCY_CODES: Record<string, string> = { BYN: '933', USD: '840', EUR: '978', RUB: '643', CNY: '156' };
/** Пункты меню, которые стоит открыть: где могут быть движения за текущий день. */
const INTERESTING = /движ|оборот|текущ|операц|выписк|проводк|поступлен|списан|history|turnover|movement|vpsk|extract/i;
const MAX_PAGES = 20;

interface NetEntry { t: string; method: string; url: string; status: number; type: string; file?: string }

const net: NetEntry[] = [];
let netSeq = 0;

function save(name: string, content: string): string {
  const file = path.join(OUT_DIR, name.replace(/[^\w.-]+/g, '_'));
  fs.writeFileSync(file, content);
  return file;
}

function minskToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Minsk' }).format(new Date());
}

/** Пишет все XHR/fetch/document-ответы с dbo2.bveb.by; тела HTML/JSON сохраняет в файлы. */
function recordNetwork(page: Page): void {
  page.on('response', (res: Response) => {
    void (async () => {
      const req = res.request();
      const url = res.url();
      if (!url.startsWith(BASE_URL)) return;
      const rtype = req.resourceType();
      if (!['xhr', 'fetch', 'document'].includes(rtype)) return;
      const type = res.headers()['content-type'] ?? '';
      const entry: NetEntry = { t: new Date().toISOString(), method: req.method(), url, status: res.status(), type };
      if (/json|html|text/.test(type)) {
        try {
          const body = await res.text();
          const ext = type.includes('json') ? 'json' : 'html';
          const short = new URL(url).pathname.split('/').filter(Boolean).slice(-2).join('-') || 'root';
          entry.file = save(`net-${String(++netSeq).padStart(3, '0')}-${req.method()}-${short}.${ext}`, body);
        } catch { /* тело недоступно (редирект) */ }
      }
      net.push(entry);
    })();
  });
}

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => null);
  await page.waitForTimeout(1_500);
}

async function snapshot(page: Page, label: string): Promise<void> {
  await page.screenshot({ path: path.join(OUT_DIR, `${label}.png`), fullPage: true }).catch(() => null);
  save(`${label}.html`, await page.content().catch(() => ''));
}

/** Все ссылки и элементы с data-url на странице: меню кабинета. */
async function collectLinks(page: Page): Promise<{ text: string; href: string }[]> {
  return page.evaluate(() => {
    const out: { text: string; href: string }[] = [];
    const els = Array.from(document.querySelectorAll('a[href], [data-url], [data-href], [data-portlet-url]'));
    for (let i = 0; i < els.length; i++) {
      const el = els[i];
      const href = el.getAttribute('href') || el.getAttribute('data-url') ||
        el.getAttribute('data-href') || el.getAttribute('data-portlet-url') || '';
      const text = (el.textContent || el.getAttribute('title') || '').replace(/\s+/g, ' ').trim();
      if (!href || href === '#' || href.startsWith('javascript:') || href.startsWith('mailto:')) continue;
      out.push({ text, href });
    }
    return out;
  });
}

/** Поля формы портлета (name, тип, подпись, состояние) и модель Kendo MVVM, если есть. */
async function describeForm(page: Page): Promise<unknown> {
  return page.evaluate(() => {
    const fields: Record<string, unknown>[] = [];
    const inputs = Array.from(document.querySelectorAll('input, select, textarea'));
    for (let i = 0; i < inputs.length; i++) {
      const el = inputs[i] as HTMLInputElement;
      if (el.type === 'password' || el.name === '__RequestVerificationToken') continue;
      const id = el.id;
      const label = id ? document.querySelector(`label[for="${id}"]`)?.textContent?.trim() : undefined;
      const parentText = (el.closest('label, .form-group, .row, div')?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 160);
      fields.push({
        tag: el.tagName, name: el.name, id, type: el.type, value: el.type === 'hidden' ? el.value : undefined,
        checked: el.type === 'checkbox' || el.type === 'radio' ? el.checked : undefined,
        dataBind: el.getAttribute('data-bind'), label, parentText,
      });
    }
    let vm: unknown = null;
    try {
      const kendo = (window as unknown as Record<string, unknown>)['kendo'] as
        { dataFor: (el: Element) => { toJSON?: () => unknown } | null } | undefined;
      const anchor = document.querySelector('[data-bind*="DateFrom"], [name="DateFrom"]');
      if (kendo && anchor) {
        const m = kendo.dataFor(anchor);
        vm = m && typeof m.toJSON === 'function' ? m.toJSON() : null;
      }
    } catch { /* нет модели */ }
    const forms = Array.from(document.querySelectorAll('form')).map((f) => ({
      id: f.id, action: f.getAttribute('action'), method: f.getAttribute('method'),
      ajax: f.getAttribute('data-ajax'), submitUrl: f.getAttribute('data-submit-url'),
    }));
    return { forms, fields, viewModel: vm };
  });
}

async function setDatesAndSubmit(page: Page, from: string, to: string): Promise<string> {
  await page.evaluate((a: { from: string; to: string }) => {
    const kendo = (window as unknown as Record<string, unknown>)['kendo'] as
      { dataFor: (el: Element) => { set?: (k: string, v: string) => void } | null } | undefined;
    const el = document.querySelector('[data-bind*="DateFrom"], [name="DateFrom"]');
    if (!kendo || !el) return;
    const vm = kendo.dataFor(el);
    if (vm && typeof vm.set === 'function') { vm.set('DateFrom', a.from); vm.set('DateTo', a.to); }
  }, { from: isoToDMY(from), to: isoToDMY(to) });
  const [res] = await Promise.all([
    page.waitForResponse((r) => /Vpsk\/(List|Index)/.test(r.url()) && r.request().method() === 'POST', { timeout: 35_000 }),
    page.locator('#form_prtl0 button[type="submit"], form[data-ajax="true"] button[type="submit"], button[type="submit"]').first().click(),
  ]);
  return res.text();
}

async function reconVpsk(page: Page, account: string, currency: string): Promise<void> {
  const today = minskToday();
  const url = `${BASE_URL}/Cabinet/Accounts/Vpsk/Extract/?id=${encodeURIComponent(account)}&currency=${currency}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 });
  await settle(page);
  if (!/\/Cabinet\//.test(page.url())) {
    await page.goto(`${BASE_URL}/Cabinet/`, { waitUntil: 'networkidle', timeout: 25_000 });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    await settle(page);
  }
  await snapshot(page, `vpsk-${account}-form`);
  save(`vpsk-${account}-form.json`, JSON.stringify(await describeForm(page), null, 2));

  // Выписка с to = сегодня: подтверждаем, что текущий день не возвращается, и смотрим,
  // нет ли в ответе отдельного блока (итогов/«необработанных») за сегодня.
  for (const [label, from] of [['today', today], ['week', shiftDays(today, -7)]] as const) {
    try {
      const html = await setDatesAndSubmit(page, from, today);
      save(`vpsk-${account}-list-${label}.html`, html);
      await settle(page);
      await snapshot(page, `vpsk-${account}-result-${label}`);
    } catch (err) {
      save(`vpsk-${account}-list-${label}.error.txt`, String(err));
    }
  }
}

function shiftDays(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function main(): Promise<void> {
  const accounts = process.argv.slice(2).filter((a) => /^BY/i.test(a));
  const currency = CURRENCY_CODES[(process.env.RECON_CURRENCY ?? 'BYN').toUpperCase()] ?? '933';
  for (const f of fs.existsSync(OUT_DIR) ? fs.readdirSync(OUT_DIR) : []) fs.rmSync(path.join(OUT_DIR, f), { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  initConfigStore();

  const page = await login();
  recordNetwork(page);
  await page.waitForTimeout(15_000);
  const summary: Record<string, unknown> = { startedAt: new Date().toISOString(), minskToday: minskToday(), accounts };

  try {
    // 1. Дашборд и меню
    await page.goto(`${BASE_URL}/Cabinet/`, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    await settle(page);
    await snapshot(page, 'dashboard');
    const links = await collectLinks(page);
    // Плитки «Навигатора запросов» раскрывают подменю без перехода по ссылке.
    for (const tile of ['Выписки', 'Документы из банка', 'Архивные документы']) {
      try {
        await page.locator(`a:has-text("${tile}")[href^="javascript"]`).first().click({ timeout: 5_000 });
        await page.waitForTimeout(1_500);
        await snapshot(page, `navigator-${tile}`);
        links.push(...(await collectLinks(page)).map((l) => ({ ...l, text: `[${tile}] ${l.text}` })));
      } catch (err) { save(`navigator-${tile}.error.txt`, String(err)); }
    }
    save('menu-links.json', JSON.stringify(links, null, 2));

    // 2. Форма выписки и ответ за сегодня по каждому счёту
    for (const acc of accounts) {
      try { await reconVpsk(page, acc, currency); } catch (err) { save(`vpsk-${acc}.error.txt`, String(err)); }
    }

    // 3. Пункты меню, похожие на движения / операции
    const seen = new Set<string>();
    const targets = links
      .filter((l) => INTERESTING.test(`${l.text} ${l.href}`))
      .map((l) => ({ ...l, abs: new URL(l.href, BASE_URL).toString() }))
      .filter((l) => l.abs.startsWith(BASE_URL) && !/logout|logoff|exit|выход/i.test(`${l.text} ${l.abs}`))
      .filter((l) => (seen.has(l.abs) ? false : (seen.add(l.abs), true)))
      .slice(0, MAX_PAGES);
    summary.visited = [];
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      const label = `page-${String(i + 1).padStart(2, '0')}`;
      try {
        await page.goto(t.abs, { waitUntil: 'domcontentloaded', timeout: 20_000 });
        await settle(page);
        await snapshot(page, label);
        save(`${label}-form.json`, JSON.stringify(await describeForm(page), null, 2));
        (summary.visited as unknown[]).push({ label, text: t.text, url: t.abs, landed: page.url() });
      } catch (err) {
        (summary.visited as unknown[]).push({ label, text: t.text, url: t.abs, error: String(err) });
      }
    }
  } finally {
    // Сессия БелВЭБа запоминает последний портлет — вернуться на дашборд.
    await page.goto(`${BASE_URL}/Cabinet/`, { waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(() => null);
    await page.waitForTimeout(1_000);
    save('network.json', JSON.stringify(net, null, 2));
    save('summary.json', JSON.stringify(summary, null, 2));
    await closeBrowser();
  }
  console.log(`Готово: ${OUT_DIR} (${net.length} запросов записано)`);
}

main().catch(async (err) => {
  console.error(err);
  await closeBrowser().catch(() => null);
  process.exit(1);
});
