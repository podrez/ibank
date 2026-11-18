# Account Balances Service

Headless browser service that logs into multiple Belarusian banks, scrapes account balances and statements on a schedule, persists them to SQLite, and exposes a REST API for consumption by a 1C accounting system.

Corporate banks are polled every 5 minutes on working days 09:00–17:00 Minsk time; retail banks that operate 24/7 (iParitet) are polled around the clock. Besides cached balances and transactions, the API can read a few things live from the bank on request — e.g. the last outgoing payment order number at Priorbank.

**Supported banks:** Alfa-Bank BY (`online.alfabank.by`), Priorbank BY (`www.ibank.priorbank.by`), БелВЭБ BY (`dbo2.bveb.by`), Паритетбанк BY corporate (`new.eparitet.by`), Паритетбанк физлица / iParitet (`iparitet.by`)

## Tech stack

- **Node.js + TypeScript**
- **Playwright** (Chromium) — headless browser for bank login and scraping
- **Drizzle ORM + better-sqlite3** — SQLite persistence
- **Express** — REST API
- **node-cron** — scheduler
- **Docker** — containerised deployment

## Requirements

- Node.js 20 (the Docker image is built on `node:20-slim`) — or just Docker
- Bank credentials for each bank you want to enable

## Quick start

### Local

```bash
# 1. Install dependencies (including Chromium)
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env — set credentials for the banks you want to enable, and API_KEY

# 3. Apply DB migrations
npm run db:migrate

# 4. Run in dev mode (auto-restarts on change)
npm run dev
```

### Docker

```bash
cp stack.env.example stack.env
# Edit stack.env — set credentials and API_KEY

docker compose up --build -d
docker compose logs -f
```

The container applies DB migrations on start (`node dist/db/migrate.js && node dist/index.js`) and keeps the database, sessions and debug files in the `account-balances-data` volume (`/app/data`).

The service is available at `http://localhost:3000`.

## Web UI

A built-in dashboard is served at `http://localhost:3000/`.

- **Login screen** — enter the `API_KEY` value; the key is stored in `sessionStorage` for the browser session.
- **Account cards** — show bank name, account number, currency, current balance, the time the balance was last scraped, and today's credit/debit totals.
- **Grouping** — cards are grouped by «Тип · валюта», «Тип», «Валюта», «Банк» or «Без групп», with per-group totals. In edit mode groups and cards can be reordered by drag and drop. Mode and order are stored in `localStorage`.
- **Sync button** — triggers `POST /api/refresh` and reloads data after 6 seconds.
- **Auto-refresh** — accounts are polled every 30 seconds with a visible countdown in the header.
- **Visibility toggle** — the gear button enters edit mode where individual accounts can be hidden from the dashboard. Hidden state is stored in `localStorage`.
- **Statement viewer** — accounts enabled for statement sync show a "Выписка" button. Clicking it opens a modal with a filterable transaction table (date range, counterparty name and UNP, description, debit/credit) and an "Обновить из банка" button to trigger a fresh download from the bank.
- **Settings panel** — the sliders button in the header opens a settings modal with sections:
  - **Банки** — credentials (login/password) for each bank; a bank becomes enabled as soon as its login is saved. Alfa-Bank and iParitet additionally show a **«Вход по SMS»** panel for the operator-driven SMS login (see [Interactive SMS login](#interactive-sms-login-alfa-bank-iparitet)).
  - **Выписки** — checkboxes over all scraped accounts; toggling an account adds or removes it from automatic statement sync.
  - **Расписание** — start/end hours, interval, timezone, extra working days.
  - **REST API** — API key rotation (requires re-login after change); API port is shown read-only.
  - **1С** — webhook URL and credentials.
  - **Браузер** — headless mode, timeout, custom Chromium path.
  - **Отладка** — debug screenshots toggle, log level.

Settings saved via the UI are persisted to the `settings` table in SQLite and take effect immediately (scheduler restarts, browser re-launches, bank sessions are reset as needed). Environment variables in `.env` act as fallback defaults when a setting has not been saved through the UI.

No build step is required; the UI is a single self-contained HTML file served by Express.

## Interactive SMS login (Alfa-Bank, iParitet)

Alfa-Bank BY and iParitet ask for an SMS one-time code only when they challenge a
new device/session; an ordinary login/password sign-in goes straight through. So:

- Automated `login()` first reuses the session persisted to
  `<SESSION_DIR>/<bank>.json` (cookies + localStorage) and, if it is gone, **submits
  the credentials itself** and waits for the cabinet.
- If the bank actually holds on the SMS prompt (or rejects the credentials), the
  login fails with "re-authentication required". For Alfa-Bank further automatic
  attempts are then **blocked for 6 hours**, so a scheduler tick never fires an SMS
  (or a bad-password attempt) every cycle.
- An operator restores access from the web UI: **Settings → Банки → <bank> →
  «Вход по SMS» → «Войти (запросить SMS)»**. The bank sends the code, a field appears,
  the operator enters it and confirms. On success the session is persisted (and the
  block lifted); the scheduler skips the bank while the SMS step is pending.
- The same flow is available over the API: `POST /api/auth/<bank>/start` →
  `POST /api/auth/<bank>/sms` with `{ "code": "1234" }`.
- Changing a bank's credentials clears its saved session (and lifts the block).

Session files live under `SESSION_DIR` (default `./data/sessions`). If the SMS flow
stalls, enable `DEBUG_SCREENSHOTS=true` and inspect `./data/debug/alfabank-sms-*` — the
timeout error also embeds a `Page shape` dump of the page's fields and buttons.

## Environment variables

A bank is **enabled** when its `LOGIN` env var (or the corresponding setting saved via the UI) is set.

`DB_PATH`, `API_PORT`, `BASE_PATH` and `SESSION_DIR` can only be set via `.env` / environment (they require a process restart to take effect). All other variables can also be changed at runtime through the Settings panel in the web UI.

> **Docker: where to put `API_PORT`.** `docker-compose.yml` interpolates `${API_PORT}` for both the published port and the value passed into the container. Compose reads that interpolation from the **`.env` file sitting next to `docker-compose.yml`** — *not* from `stack.env` (`env_file` is only injected into the container, it is never used for interpolation). In Portainer, set it as a stack environment variable instead, which covers both. Setting it only in `stack.env` under plain `docker compose` leaves the published port at `3000`.

| Variable | Default | Description |
|---|---|---|
| `ALFABANK_LOGIN` | — | Alfa-Bank BY login (leave empty to disable) |
| `ALFABANK_PASSWORD` | — | Alfa-Bank BY password |
| `PRIORBANK_LOGIN` | — | Priorbank BY login (leave empty to disable) |
| `PRIORBANK_PASSWORD` | — | Priorbank BY password |
| `BELVEB_LOGIN` | — | БелВЭБ BY login (leave empty to disable) |
| `BELVEB_PASSWORD` | — | БелВЭБ BY password |
| `PARITETBANK_LOGIN` | — | Паритетбанк BY login (leave empty to disable) |
| `PARITETBANK_PASSWORD` | — | Паритетбанк BY password |
| `PARITETBANK_ORG` | — | Organisation name to select on login (only needed for multi-org accounts; first org is used if empty) |
| `IPARITET_LOGIN` | — | iParitet / Паритетбанк физлица login (leave empty to disable); signs in with login/password, SMS only if the bank issues a new-device challenge |
| `IPARITET_PASSWORD` | — | iParitet password |
| `DB_PATH` | `./data/accounts.db` | Path to SQLite database file |
| `SESSION_DIR` | `./data/sessions` | Where per-bank browser sessions (cookies) are persisted so an SMS login is not repeated every cycle |
| `API_PORT` | `3000` | HTTP port for the REST API (in Docker it is both the in-container port and the published host port — see below) |
| `BASE_PATH` | — | Sub-path prefix when served behind a reverse proxy (e.g. `/ibank`); leave empty when the app is at the root |
| `API_KEY` | — | Secret key to protect the API |
| `APP_TIMEZONE` | `Europe/Minsk` | IANA timezone used for scheduling, today-totals calculations, and browser locale |
| `SCHEDULE_START_HOUR` | `9` | Scraping window start hour for corporate banks (APP_TIMEZONE); iParitet is polled 24/7 |
| `SCHEDULE_END_HOUR` | `17` | Scraping window end hour for corporate banks (APP_TIMEZONE) |
| `<BANK>_SCHEDULE_END_HOUR` | — | Per-bank override of the end hour, e.g. `BELVEB_SCHEDULE_END_HOUR=20` so operations posted after 17:00 reach the cache before 1C's evening import |
| `SCHEDULE_INTERVAL_MINUTES` | `5` | Interval between scrapes (minutes) |
| `EXTRA_WORKING_DAYS` | — | Comma-separated dates (`YYYY-MM-DD`) that are working days despite falling on Sat/Sun (e.g. `2026-04-25,2026-11-07`) |
| `ALFABANK_STATEMENT_ACCOUNTS` | — | Comma-separated account numbers for automatic statement sync |
| `PRIORBANK_STATEMENT_ACCOUNTS` | — | Same for Priorbank |
| `BELVEB_STATEMENT_ACCOUNTS` | — | Same for БелВЭБ |
| `PARITETBANK_STATEMENT_ACCOUNTS` | — | Same for Паритетбанк |
| `IPARITET_STATEMENT_ACCOUNTS` | — | Same for iParitet (card/account contract numbers) |
| `ONEC_WEBHOOK_URL` | — | 1C webhook URL to notify on new transactions (leave empty to disable) |
| `ONEC_USERNAME` | — | Basic auth username for 1C |
| `ONEC_PASSWORD` | — | Basic auth password for 1C |
| `ONEC_API_KEY` | — | Value sent in the `X-Api-Key` header to 1C |
| `HEADLESS` | `true` | Run Chromium headless (`false` for local debug) |
| `BROWSER_TIMEOUT_MS` | `30000` | Playwright navigation timeout (ms) |
| `CHROMIUM_EXECUTABLE_PATH` | — | Path to a native Chromium binary (e.g. `/usr/bin/chromium-browser` on ARM64 hosts where the bundled x86_64 binary won't run) |
| `DEBUG_SCREENSHOTS` | `false` | Save debug snapshots to `./data/debug/` per bank |
| `LOG_LEVEL` | `info` | Winston log level |

## REST API

All endpoints (except `/health`) require authentication via one of:
- `X-Api-Key: <key>` header
- `Authorization: Bearer <key>` header

| Method | Path | Description |
|---|---|---|
| GET | `/api/accounts` | All accounts with latest balances |
| GET | `/api/accounts?bank=<id>` | Accounts for a specific bank (`alfabank`, `priorbank`, `belveb`, `paritetbank`, `iparitet`) |
| POST | `/api/refresh` | Force immediate balance sync (all banks) |
| POST | `/api/refresh?bank=<id>` | Force sync for a specific bank |
| GET | `/api/status` | Last sync info, account count, server time |
| GET | `/api/sync-log` | Last 20 sync log entries |
| GET | `/api/sync-log?bank=<id>` | Sync log for a specific bank |
| GET | `/api/statements` | All stored transactions |
| GET | `/api/statements?bank=alfabank&account=BY12...&from=2025-01-01&to=2025-01-31&limit=500` | Filtered transactions |
| POST | `/api/statements/refresh` | Trigger statement download for all configured accounts |
| POST | `/api/statements/refresh` (body: `{bank, account, dateFrom?, dateTo?}`) | Trigger for a specific account |
| GET | `/api/payment-orders/last?bank=priorbank[&account=BY...]` | Last outgoing payment order number, live from the bank |
| GET | `/api/today-totals` | Today's credit/debit totals per account (grouped by bank, account, currency) |
| GET | `/api/statement-accounts` | Accounts currently configured for statement syncing |
| GET | `/api/settings` | All configurable settings (sensitive values masked as `***`) |
| POST | `/api/settings` | Save settings; `***` = keep existing value, `""` = clear |
| GET | `/api/settings/accounts` | All scraped accounts with `statementEnabled` flag |
| GET | `/api/auth` | Banks supporting interactive (SMS) login, with stage and saved-session flag |
| GET | `/api/auth/<bank>/status` | Interactive-login stage (`idle` / `awaiting_sms`) and whether a session is saved |
| POST | `/api/auth/<bank>/start` | Begin operator-driven login (fills credentials, triggers SMS) |
| POST | `/api/auth/<bank>/sms` (body: `{code}`) | Submit the SMS code for a pending login |
| POST | `/api/auth/<bank>/cancel` | Abort a pending interactive login |
| GET | `/health` | Health check (no auth required) |

### Example: GET /api/accounts

```json
{
  "accounts": [
    {
      "id": 1,
      "bank": "alfabank",
      "accountNumber": "BY12ALFA...",
      "currency": "BYN",
      "name": "Текущий счет",
      "balance": 1234.56,
      "available": 1234.56,
      "balanceUpdatedAt": "2024-01-15T10:00:05.000Z",
      "createdAt": "2024-01-01T00:00:00.000Z"
    }
  ],
  "count": 3
}
```

### Example: GET /api/statements

```json
{
  "transactions": [
    {
      "id": 42,
      "bank": "belveb",
      "accountNumber": "BY12BVEB...",
      "transactionDate": "2026-05-28",
      "reference": "123456",
      "description": "Оплата услуг",
      "debit": 250.00,
      "credit": null,
      "currency": "BYN",
      "counterpartyUnp": "100123456",
      "counterpartyName": "ООО Пример",
      "counterpartyAccount": "BY34PJCB...",
      "operationCode": "17",
      "txKey": "123456:8bc8eda68edf3f29",
      "importedAt": "2026-05-28T10:05:00.000Z"
    }
  ],
  "count": 1
}
```

### Example: GET /api/today-totals

```json
{
  "totals": [
    { "bank": "alfabank", "accountNumber": "BY12ALFA...", "currency": "BYN", "totalCredit": 500.00, "totalDebit": 120.50 }
  ],
  "date": "2026-05-22"
}
```

### Example: GET /api/payment-orders/last?bank=priorbank

Read live from the bank on every call (Priorbank only for now). `lastNumber` is the
**highest** number among this year's newest ruble payment orders, all statuses
included; `account=BY...` narrows it to one payer account. `null` when none found.

```json
{
  "bank": "priorbank",
  "account": null,
  "lastNumber": "2076",
  "document": {
    "number": "2076", "date": "2026-11-18", "status": "Проведен банком",
    "amount": 328.2, "currency": "BYN", "payerAccount": "BY27PJCB...",
    "recipientName": "...", "recipientAccount": "BY76ALFA...", "purpose": "..."
  },
  "examined": 100,
  "checkedAt": "2026-11-18T07:26:11.000Z"
}
```

## Architecture

```
Scheduler (node-cron)
  └─► scraper/index.ts (syncAllBanks / syncAllStatements)
        └─► for each enabled bank:
              ├─► banks/<bank>/auth.ts      — Playwright login
              ├─► banks/<bank>/accounts.ts  — Scrape balances
              │     └─► db/index.ts         — Persist to SQLite (keyed by bank + accountNumber)
              │           └─► GET /api/accounts — Served to 1C
              └─► banks/<bank>/statements.ts — Scrape transactions
                    └─► db/index.ts          — Persist to SQLite (transactions table)
                          └─► notify/onec.ts — POST to 1C webhook on new imports
```

A single cron task (`scheduler/index.ts`) fires every `SCHEDULE_INTERVAL_MINUTES` and picks the banks to sync on that tick: corporate banks only inside their working window, retail banks (`roundTheClock`, iParitet) always. Syncs never overlap — one shared Chromium, one isolated browser context per bank (`scraper/browser.ts`).

Configuration is read from `config/store.ts` (DB-backed key-value cache, falls back to `process.env`). All runtime settings except `DB_PATH`, `API_PORT`, `BASE_PATH` and `SESSION_DIR` can be updated via `POST /api/settings` without restarting the process.

Each bank adapter uses the strategy best suited to that bank's web application:

- **Alfa-Bank** — XHR/fetch response interception, with DOM scraping as fallback; reuses a persisted browser session (see [Interactive SMS login](#interactive-sms-login-alfa-bank-iparitet)).
- **Priorbank** — runs two cabinets on one session: balances are intercepted from the old Kendo cabinet (`/v1/`), statements come from the new cabinet's JSON API (`/v2/Accounts/GetStatementData`). The last payment order number is read from the old cabinet's document portlet over the context's HTTP client, without navigating the page a sync may be using.
- **БелВЭБ** — direct AJAX portlet fetch, with Kendo Grid DOM scraping as fallback. The «за период» statement omits the current day, so today's operations are fetched separately («сегодня») and merged.
- **Паритетбанк (corporate)** — signs in directly on `new.eparitet.by` and calls its REST API via `page.evaluate(fetch(...))`; stale keep-alive connections are dropped before each cycle (`paritetbank/connection.ts`).
- **iParitet (Паритетбанк физлица)** — Angular SPA with a bearer-token JSON API. The token is sniffed from the SPA's own `Authorization` header (falling back to sessionStorage) and the JSON API is called directly. Only operations the bank has posted are stored, not authorisation holds.

Statement scraping stores transactions in the `transactions` table. After each successful import, if new transactions were found, a `POST` notification is sent to the configured 1C webhook.

### Transaction deduplication

Every statement sync re-reads at least the last 7 days, so rows are inserted with `INSERT … ON CONFLICT DO NOTHING` against the unique index `(bank, account_number, transaction_date, tx_key)`. The document number alone is not an identity (a bank can issue two payments with the same number), so `tx_key` (`src/utils/txkey.ts`) hashes the number together with the amounts, counterparty account and payment purpose, keeping the number as a readable prefix (`123456:8bc8eda68edf3f29`). Changing the formula requires bumping `TX_KEY_VERSION`; stored keys are then recomputed on startup.

## Development

```bash
npm run dev          # Run with tsx watch (auto-restart on change)
npm run build        # Compile TypeScript to dist/
npm start            # Run compiled build

npm run db:generate  # Generate Drizzle migrations after schema changes
npm run db:migrate   # Apply migrations to SQLite
npm run db:studio    # Open Drizzle Studio (DB browser)
```

## Debugging the scraper

Set `DEBUG_SCREENSHOTS=true` via `.env` or the Settings panel, trigger a sync, then inspect `./data/debug/`:

| Bank | Balance debug files | Statement debug files |
|---|---|---|
| Alfa-Bank | `alfabank-dashboard.html` / `.png` | `alfabank-statement-<account>.html` / `.png` |
| Priorbank | `priorbank-dashboard.html` / `.png` | `priorbank-stmt-<account>-response.json` |
| БелВЭБ | `belveb-dashboard.html` / `.png` | `belveb-stmt-<account>-<step>.html` / `.png` |
| Паритетбанк | `paritetbank-accounts-response.json` | `paritetbank-stmt-<account>-response.json` |
| iParitet | `iparitet-accounts-response.json` | `iparitet-stmt-<account>-response.json` |

Update the relevant `src/banks/<bank>/accounts.ts` or `statements.ts` based on what the debug files reveal.

For investigating a cabinet (menu, forms, XHR responses) there are read-only recon scripts; they log in with the same credentials as the service:

```bash
npx tsx src/tools/belveb-recon.ts BY00BELV...            # → ./data/debug/belveb-recon/
RECON_IDS=2833,1141 npx tsx src/tools/priorbank-recon.ts  # → ./data/debug/priorbank-recon/
```

A separate login may knock out the running service's session (it re-logs in on the next cycle). Delete the output directories afterwards — they contain account data.

## 1C notifications

When `ONEC_WEBHOOK_URL` is set, the service sends a `POST` request to that URL after each statement sync that imports at least one new transaction. Failed requests are retried up to 3 times with exponential backoff (500 ms, 1 s, 2 s); only 5xx responses and network errors trigger a retry — 4xx responses are surfaced immediately as warnings.

**Request headers:**
```
Authorization: Basic <base64(ONEC_USERNAME:ONEC_PASSWORD)>
X-Api-Key: <ONEC_API_KEY>
Content-Type: application/json
```

**Request body:**
```json
{ "bank": "alfabank", "account": "BY12ALFA..." }
```

Notification failures are logged as warnings and do not interrupt the sync.

## Adding a new bank

1. Create `src/banks/<bankid>/auth.ts` — `login(): Promise<Page>` and `isLoggedIn(page): Promise<boolean>`
2. Create `src/banks/<bankid>/accounts.ts` — `scrapeAccounts(page): Promise<ScrapedAccount[]>`
3. Create `src/banks/<bankid>/statements.ts` — `scrapeStatement(page, req): Promise<ScrapedTransaction[]>` (optional)
4. Create `src/banks/<bankid>/index.ts` — class implementing `BankAdapter`
5. Register in `src/banks/index.ts` under a new env var (e.g. `NEWBANK_LOGIN`) using `getConfig()`
6. Add the new credential keys to `ALL_SETTING_KEYS` in `src/config/store.ts` and to `BANK_META` in `public/index.html`
7. Add theming in `public/index.html`: CSS classes `.bank-<id>` and `.bank-card-<id>`, and entries in `bankLabel()` and `bankIcon()`
