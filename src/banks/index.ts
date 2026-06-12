import { BankAdapter } from './types';
import { AlfabankAdapter } from './alfabank';
import { PriorbankAdapter } from './priorbank';
import { BelvebAdapter } from './belveb';
import { ParitetbankAdapter } from './paritetbank';
import { getConfig } from '../config/store';

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

  const alfabankLogin = getConfig('ALFABANK_LOGIN') ?? getConfig('BANK_LOGIN');
  if (alfabankLogin) {
    banks.push(new AlfabankAdapter());
  }

  const priorbankLogin = getConfig('PRIORBANK_LOGIN');
  if (priorbankLogin) {
    banks.push(new PriorbankAdapter());
  }

  const belvebLogin = getConfig('BELVEB_LOGIN');
  if (belvebLogin) {
    banks.push(new BelvebAdapter());
  }

  const paritetbankLogin = getConfig('PARITETBANK_LOGIN');
  if (paritetbankLogin) {
    banks.push(new ParitetbankAdapter());
  }

  _banks = banks;
  return banks;
}

/** Force re-evaluation of enabled banks on next call to getEnabledBanks(). */
export function resetEnabledBanks(): void {
  _banks = null;
}

export type { BankAdapter, ScrapedAccount, ScrapedTransaction, StatementRequest } from './types';
