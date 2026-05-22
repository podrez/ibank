import { BankAdapter } from './types';
import { AlfabankAdapter } from './alfabank';
import { PriorbankAdapter } from './priorbank';
import { BelvebAdapter } from './belveb';

// Singleton instances — adapters hold the active Playwright page, so recreating
// them on every sync cycle leaks browser tabs (each login() opens ctx.newPage()
// without closing the previous one).
let _banks: BankAdapter[] | null = null;

/**
 * Returns bank adapters that have credentials configured.
 * Alfabank: ALFABANK_LOGIN (or legacy BANK_LOGIN) must be set.
 * Priorbank: PRIORBANK_LOGIN must be set.
 */
export function getEnabledBanks(): BankAdapter[] {
  if (_banks) return _banks;

  const banks: BankAdapter[] = [];

  const alfabankLogin = process.env.ALFABANK_LOGIN ?? process.env.BANK_LOGIN;
  if (alfabankLogin) {
    banks.push(new AlfabankAdapter());
  }

  const priorbankLogin = process.env.PRIORBANK_LOGIN;
  if (priorbankLogin) {
    banks.push(new PriorbankAdapter());
  }

  const belvebLogin = process.env.BELVEB_LOGIN;
  if (belvebLogin) {
    banks.push(new BelvebAdapter());
  }

  _banks = banks;
  return banks;
}

export type { BankAdapter, ScrapedAccount, ScrapedTransaction, StatementRequest } from './types';
