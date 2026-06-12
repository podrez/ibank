import { Page } from 'playwright';
import fs from 'fs';
import path from 'path';
import { getConfig } from '../config/store';

const DEBUG_DIR = './data/debug';

function ensureDir(): void {
  if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });
}

/**
 * Save a full-page screenshot + HTML snapshot to ./data/debug/<name>.{png,html}.
 * No-op unless DEBUG_SCREENSHOTS=true.
 */
export async function saveDebugSnapshot(page: Page, name: string): Promise<void> {
  if (getConfig('DEBUG_SCREENSHOTS') !== 'true') return;
  try {
    ensureDir();
    await page.screenshot({ path: path.join(DEBUG_DIR, `${name}.png`), fullPage: true }).catch(() => null);
    await page.content()
      .then((html) => fs.writeFileSync(path.join(DEBUG_DIR, `${name}.html`), html))
      .catch(() => null);
  } catch { /* ignore */ }
}

/**
 * Returns a snapper closure for statement scraping.
 * Usage: const snap = makeSnapper(page, 'belveb', req.accountNumber);
 *        await snap('01-after-submit');
 * Files: ./data/debug/<prefix>-stmt-<safeAccount>-<label>.{png,html}
 */
export function makeSnapper(page: Page, prefix: string, accountNumber: string) {
  return async (label: string): Promise<void> => {
    if (getConfig('DEBUG_SCREENSHOTS') !== 'true') return;
    try {
      ensureDir();
      const safe = accountNumber.replace(/[^A-Z0-9]/gi, '_');
      const base = path.join(DEBUG_DIR, `${prefix}-stmt-${safe}-${label}`);
      await page.screenshot({ path: `${base}.png`, fullPage: true }).catch(() => null);
      fs.writeFileSync(`${base}.html`, await page.content().catch(() => ''));
    } catch { /* ignore */ }
  };
}
