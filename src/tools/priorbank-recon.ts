/**
 * Разведка нового кабинета Приорбанка: где лежат исходящие платёжные поручения.
 *
 *   RECON_IDS=2833,1141 npx tsx src/tools/priorbank-recon.ts   (id пунктов меню /Cabinet/<id>)
 *
 * Входит, открывает /Cabinet, сохраняет меню (/v2/User/GetUserMenu) и все XHR-ответы,
 * затем открывает пункты меню, похожие на платежи/документы. В банке только читает.
 * Результат — ./data/debug/priorbank-recon/ (удалить после анализа).
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { Page, Response } from 'playwright';
import { initConfigStore } from '../config/store';
import { login } from '../banks/priorbank/auth';
import { closeBrowser } from '../scraper/browser';

const BASE_URL = 'https://www.ibank.priorbank.by';
const OUT_DIR = './data/debug/priorbank-recon';
const INTERESTING = /плат[её]ж|поручен|документ|payment|order|doc/i;
const MAX_PAGES = 15;

interface NetEntry { method: string; url: string; status: number; reqBody?: string; file?: string }
const net: NetEntry[] = [];
let seq = 0;

function save(name: string, content: string): string {
  const file = path.join(OUT_DIR, name.replace(/[^\w.-]+/g, '_'));
  fs.writeFileSync(file, content);
  return file;
}

function recordNetwork(page: Page): void {
  page.on('response', (res: Response) => {
    void (async () => {
      const req = res.request();
      const url = res.url();
      if (!['xhr', 'fetch'].includes(req.resourceType())) return;
      if (/\.(js|css|png|svg|woff2?)(\?|$)/i.test(url)) return;
      const entry: NetEntry = { method: req.method(), url, status: res.status() };
      const body = req.postData();
      if (body && !/password/i.test(body)) entry.reqBody = body.slice(0, 2000);
      try {
        const text = await res.text();
        const short = new URL(url).pathname.split('/').filter(Boolean).slice(-2).join('-');
        entry.file = save(`net-${String(++seq).padStart(3, '0')}-${short}.json`, text);
      } catch { /* нет тела */ }
      net.push(entry);
    })();
  });
}

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => null);
  await page.waitForTimeout(2_000);
}

function flattenMenu(node: unknown, out: { title: string; url: string }[] = []): { title: string; url: string }[] {
  if (Array.isArray(node)) { node.forEach((n) => flattenMenu(n, out)); return out; }
  if (node && typeof node === 'object') {
    const o = node as Record<string, unknown>;
    const title = String(o.title ?? o.name ?? o.text ?? o.caption ?? '');
    const url = String(o.url ?? o.link ?? o.href ?? o.path ?? o.route ?? '');
    if (url && url !== 'undefined' && url !== 'null') out.push({ title, url });
    Object.values(o).forEach((v) => { if (v && typeof v === 'object') flattenMenu(v, out); });
  }
  return out;
}

async function main(): Promise<void> {
  for (const f of fs.existsSync(OUT_DIR) ? fs.readdirSync(OUT_DIR) : []) fs.rmSync(path.join(OUT_DIR, f), { force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  initConfigStore();

  const page = await login();
  recordNetwork(page);
  try {
    await page.goto(`${BASE_URL}/Cabinet/1`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await settle(page);
    await page.screenshot({ path: path.join(OUT_DIR, 'cabinet.png'), fullPage: true }).catch(() => null);

    const menuText = await page.evaluate(async () => {
      const r = await fetch('/v2/User/GetUserMenu', { credentials: 'same-origin', headers: { 'X-Requested-With': 'XMLHttpRequest' } });
      return r.text();
    });
    save('menu.json', menuText);
    let menu: { title: string; url: string }[] = [];
    try { menu = flattenMenu(JSON.parse(menuText)); } catch { /* не JSON */ }
    save('menu-flat.json', JSON.stringify(menu, null, 2));

    const ids = (process.env.RECON_IDS ?? '2833,1141').split(',');
    for (const id of ids) {
      console.log(`→ /Cabinet/${id}`);
      await page.goto(`${BASE_URL}/Cabinet/${id}`, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => null);
      await settle(page);
      await page.waitForTimeout(3_000);
      await page.screenshot({ path: path.join(OUT_DIR, `cab-${id}.png`), fullPage: true }).catch(() => null);
    }

    const seen = new Set<string>();
    const targets = menu
      .filter((m) => INTERESTING.test(`${m.title} ${m.url}`))
      .filter((m) => (seen.has(m.url) ? false : (seen.add(m.url), true)))
      .slice(0, MAX_PAGES);
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      const abs = new URL(t.url, `${BASE_URL}/Cabinet/`).toString();
      if (!abs.startsWith(BASE_URL) || /logout|logoff/i.test(abs)) continue;
      console.log(`→ ${t.title} ${abs}`);
      await page.goto(abs, { waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => null);
      await settle(page);
      await page.screenshot({ path: path.join(OUT_DIR, `page-${i + 1}.png`), fullPage: true }).catch(() => null);
    }
  } finally {
    save('network.json', JSON.stringify(net, null, 2));
    await closeBrowser();
  }
  console.log(`Готово: ${OUT_DIR} (${net.length} запросов)`);
}

main().catch(async (err) => {
  console.error(err);
  await closeBrowser().catch(() => null);
  process.exit(1);
});
