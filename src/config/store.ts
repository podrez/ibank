import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

// Keys whose values are masked in public output and skipped on POST when "***"
const SENSITIVE_KEYS = new Set([
  'ALFABANK_PASSWORD',
  'PRIORBANK_PASSWORD',
  'BELVEB_PASSWORD',
  'PARITETBANK_PASSWORD',
  'API_KEY',
  'ONEC_PASSWORD',
  'ONEC_API_KEY',
]);

// All setting keys exposed via the settings API
export const ALL_SETTING_KEYS = [
  'ALFABANK_LOGIN',
  'ALFABANK_PASSWORD',
  'PRIORBANK_LOGIN',
  'PRIORBANK_PASSWORD',
  'BELVEB_LOGIN',
  'BELVEB_PASSWORD',
  'PARITETBANK_LOGIN',
  'PARITETBANK_PASSWORD',
  'PARITETBANK_ORG',
  'SCHEDULE_START_HOUR',
  'SCHEDULE_END_HOUR',
  'SCHEDULE_INTERVAL_MINUTES',
  'APP_TIMEZONE',
  'EXTRA_WORKING_DAYS',
  'API_KEY',
  'HEADLESS',
  'BROWSER_TIMEOUT_MS',
  'CHROMIUM_EXECUTABLE_PATH',
  'ALFABANK_STATEMENT_ACCOUNTS',
  'PRIORBANK_STATEMENT_ACCOUNTS',
  'BELVEB_STATEMENT_ACCOUNTS',
  'PARITETBANK_STATEMENT_ACCOUNTS',
  'ONEC_WEBHOOK_URL',
  'ONEC_USERNAME',
  'ONEC_PASSWORD',
  'ONEC_API_KEY',
  'DEBUG_SCREENSHOTS',
  'LOG_LEVEL',
] as const;

export type SettingKey = typeof ALL_SETTING_KEYS[number];

// In-memory cache
const cache = new Map<string, string>();
let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (db) return db;
  const dbPath = process.env.DB_PATH ?? './data/accounts.db';
  const dbDir = path.dirname(dbPath);
  if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
  db = new Database(dbPath);
  return db;
}

/**
 * Load all settings from DB into the in-memory cache.
 * Must be called after runMigrations().
 */
export function initConfigStore(): void {
  const rows = getDb().prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
  for (const row of rows) {
    cache.set(row.key, row.value);
  }
}

/**
 * Get a config value. Priority: DB cache → process.env → fallback.
 */
export function getConfig(key: string, fallback?: string): string | undefined {
  if (cache.has(key)) return cache.get(key)!;
  const envVal = process.env[key];
  if (envVal !== undefined && envVal !== '') return envVal;
  return fallback;
}

/**
 * Persist a config value to DB and update cache.
 * Passing empty string deletes the entry (falls back to env).
 */
export function setConfig(key: string, value: string): void {
  if (value === '') {
    deleteConfig(key);
    return;
  }
  getDb()
    .prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
              ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .run(key, value);
  cache.set(key, value);
}

/**
 * Remove a config entry from DB and cache (falls back to env on next read).
 */
export function deleteConfig(key: string): void {
  getDb().prepare('DELETE FROM settings WHERE key = ?').run(key);
  cache.delete(key);
}

export function isSensitive(key: string): boolean {
  return SENSITIVE_KEYS.has(key);
}

/**
 * Returns all known settings for the public API.
 * Sensitive keys: "***" if set, "" if not set.
 */
export function getAllConfigPublic(): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of ALL_SETTING_KEYS) {
    const raw = getConfig(key);
    if (isSensitive(key)) {
      result[key] = raw ? '***' : '';
    } else {
      result[key] = raw ?? '';
    }
  }
  return result;
}
