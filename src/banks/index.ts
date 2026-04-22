import { BankAdapter } from './types';
import { AlfabankAdapter } from './alfabank';
import { PriorbankAdapter } from './priorbank';

/**
 * Returns bank adapters that have credentials configured.
 * Alfabank: ALFABANK_LOGIN (or legacy BANK_LOGIN) must be set.
 * Priorbank: PRIORBANK_LOGIN must be set.
 */
export function getEnabledBanks(): BankAdapter[] {
  const banks: BankAdapter[] = [];

  const alfabankLogin = process.env.ALFABANK_LOGIN ?? process.env.BANK_LOGIN;
  if (alfabankLogin) {
    banks.push(new AlfabankAdapter());
  }

  const priorbankLogin = process.env.PRIORBANK_LOGIN;
  if (priorbankLogin) {
    banks.push(new PriorbankAdapter());
  }

  return banks;
}

export type { BankAdapter, ScrapedAccount, ScrapedTransaction, StatementRequest } from './types';
