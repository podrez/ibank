import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import path from 'path';
import fs from 'fs';
import { logger } from '../logger';
import { computeTxKey, TX_KEY_VERSION } from '../utils/txkey';

const dbPath = process.env.DB_PATH ?? './data/accounts.db';
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const sqlite = new Database(dbPath);
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('foreign_keys = ON');

export const db = drizzle(sqlite, { schema });

export function runMigrations() {
  migrate(db, { migrationsFolder: './drizzle/migrations' });
  rebuildTxKeys();
}

/** Internal marker (not exposed by the settings API) of the stored tx_key format. */
const TX_KEY_SETTING = '_txKeyVersion';

interface TxKeyRow {
  id: number;
  tx_key: string;
  reference: string | null;
  description: string | null;
  debit: number | null;
  credit: number | null;
  counterparty_account: string | null;
}

/**
 * Recompute tx_key for stored transactions whenever the key formula changes.
 *
 * Without it a formula change is worse than the bug it fixes: every statement
 * sync re-reads the last LOOKBACK_DAYS days, and those rows would no longer
 * match the keys they were stored under, so each would be inserted a second
 * time. The key is derived from stored columns only, so it can be rebuilt in
 * place. Runs once per version — the marker lives in `settings`.
 */
function rebuildTxKeys(): void {
  const marker = sqlite
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get(TX_KEY_SETTING) as { value: string } | undefined;
  if (marker && Number(marker.value) >= TX_KEY_VERSION) return;

  const rows = sqlite
    .prepare('SELECT id, tx_key, reference, description, debit, credit, counterparty_account FROM transactions')
    .all() as TxKeyRow[];

  const update = sqlite.prepare('UPDATE transactions SET tx_key = ? WHERE id = ?');
  const setMarker = sqlite.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  );

  let rebuilt = 0;
  let conflicts = 0;

  sqlite.transaction(() => {
    for (const row of rows) {
      const key = computeTxKey({
        reference: row.reference,
        description: row.description,
        debit: row.debit,
        credit: row.credit,
        counterpartyAccount: row.counterparty_account,
      });
      if (key === row.tx_key) continue;
      try {
        update.run(key, row.id);
        rebuilt++;
      } catch (err) {
        // Two stored rows collapse onto one key — they are genuine duplicates of
        // each other. Keep both (the stale key harms only that row's future
        // dedup) and report them so they can be reconciled by hand.
        conflicts++;
        logger.warn('tx_key rebuild skipped a row — new key already taken', {
          id: row.id,
          reference: row.reference,
          error: (err as Error).message,
        });
      }
    }
    setMarker.run(TX_KEY_SETTING, String(TX_KEY_VERSION));
  })();

  if (rebuilt > 0 || conflicts > 0) {
    logger.info('Rebuilt transaction dedup keys', { version: TX_KEY_VERSION, rebuilt, conflicts });
  }
}

export { schema };
