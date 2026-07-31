import crypto from 'crypto';

/**
 * Bump when the key formula changes. Stored keys are rebuilt from the
 * transactions table on the next startup (see rebuildTxKeys in src/db/index.ts),
 * otherwise the re-scraped rows of the lookback window would be inserted a
 * second time under their new keys.
 */
export const TX_KEY_VERSION = 2;

export interface TxKeyParts {
  reference?: string | null;
  description?: string | null;
  debit?: number | null;
  credit?: number | null;
  counterpartyAccount?: string | null;
}

/**
 * Deterministic deduplication key for a transaction, unique index
 * (bank, account_number, transaction_date, tx_key).
 *
 * The document number alone is NOT unique within a day: a counterparty can send
 * two payments numbered the same, differing in amount and purpose, and BelVEB
 * lists both. Keying on the reference only made the second one collide with the
 * first and be dropped by INSERT OR IGNORE — silently, since it merely raised
 * the "skipped" count a re-scrape produces anyway. So the amounts, the
 * counterparty account and the payment purpose take part in the key as well.
 *
 * All of them survive a re-scrape unchanged, which is what dedup relies on:
 * every statement sync re-reads the last LOOKBACK_DAYS days and must recognise
 * the rows it already stored. Amounts are compared in whole cents and text with
 * its whitespace collapsed so that formatting noise doesn't fabricate a new row.
 *
 * The reference is kept as a readable prefix — a key tells you at a glance which
 * document it belongs to.
 */
export function computeTxKey(tx: TxKeyParts): string {
  const reference = normalize(tx.reference);
  const digest = crypto
    .createHash('md5')
    .update([
      reference,
      cents(tx.debit),
      cents(tx.credit),
      normalize(tx.counterpartyAccount),
      normalize(tx.description),
    ].join('|'))
    .digest('hex')
    .slice(0, 16);

  return reference ? `${reference}:${digest}` : digest;
}

/** Collapse whitespace runs and trim, so re-formatted bank text keeps its key. */
function normalize(value?: string | null): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

/** Amounts as whole cents — avoids float formatting differences between scrapes. */
function cents(value?: number | null): string {
  return value === null || value === undefined || !Number.isFinite(value)
    ? ''
    : String(Math.round(value * 100));
}
