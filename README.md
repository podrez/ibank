# Account Balances Service

Headless browser service that logs into multiple Belarusian banks, scrapes account balances on a schedule, persists them to SQLite, and exposes a REST API for consumption by a 1C accounting system.

**Supported banks:** Alfa-Bank BY (`online.alfabank.by`), Priorbank BY (`www.ibank.priorbank.by`), БелВЭБ BY (`dbo2.bveb.by`), Паритетбанк BY (`eparitet.by`)

## Tech stack

- **Node.js + TypeScript**
- **Playwright** (Chromium) — headless browser for bank login and scraping
- **Drizzle ORM + better-sqlite3** — SQLite persistence
- **Express** — REST API
- **node-cron** — scheduler
- **Docker** — containerised deployment

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

The service is available at `http://localhost:3000`.

## Web UI

A built-in dashboard is served at `http://localhost:3000/`.

- **Login screen** — enter the `API_KEY` value; the key is stored in `sessionStorage` for the browser session.
- **Account cards** — show bank name, account number, currency, current balance, the time the balance was last scraped, and today's credit/debit totals.
- **Sync button** — triggers `POST /api/refresh` and reloads data after 6 seconds.
- **Auto-refresh** — accounts are polled every 30 seconds with a visible countdown in the header.
- **Visibility toggle** — the "Настроить" button enters edit mode where individual accounts can be hidden from the dashboard. Hidden state is stored in `localStorage`.
- **Statement viewer** — accounts listed in `*_STATEMENT_ACCOUNTS` env vars show a "Выписка" button. Clicking it opens a modal with a filterable transaction table (date range, counterparty name and UNP, description, debit/credit) and an "Обновить из банка" button to trigger a fresh download from the bank.

No build step is required; the UI is a single self-contained HTML file served by Express.

## Environment variables

A bank is **enabled** when its `LOGIN` env var is set. Leave it empty to disable that bank.

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
| `DB_PATH` | `./data/accounts.db` | Path to SQLite database file |
| `API_PORT` | `3000` | HTTP port for the REST API |
| `API_KEY` | — | Secret key to protect the API |
| `APP_TIMEZONE` | `Europe/Minsk` | IANA timezone used for scheduling, today-totals calculations, and browser locale |
| `SCHEDULE_START_HOUR` | `9` | Scraping window start hour (APP_TIMEZONE) |
| `SCHEDULE_END_HOUR` | `17` | Scraping window end hour (APP_TIMEZONE) |
| `SCHEDULE_INTERVAL_MINUTES` | `5` | Interval between scrapes (minutes) |
| `EXTRA_WORKING_DAYS` | — | Comma-separated dates (`YYYY-MM-DD`) that are working days despite falling on Sat/Sun (e.g. `2026-04-25,2026-11-07`) |
| `ALFABANK_STATEMENT_ACCOUNTS` | — | Comma-separated account numbers for automatic statement sync |
| `PRIORBANK_STATEMENT_ACCOUNTS` | — | Same for Priorbank |
| `BELVEB_STATEMENT_ACCOUNTS` | — | Same for БелВЭБ |
| `PARITETBANK_STATEMENT_ACCOUNTS` | — | Same for Паритетбанк |
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
| GET | `/api/accounts?bank=<id>` | Accounts for a specific bank (`alfabank`, `priorbank`, `belveb`, `paritetbank`) |
| POST | `/api/refresh` | Force immediate balance sync (all banks) |
| POST | `/api/refresh?bank=<id>` | Force sync for a specific bank |
| GET | `/api/status` | Last sync info, account count, server time |
| GET | `/api/sync-log` | Last 20 sync log entries |
| GET | `/api/sync-log?bank=<id>` | Sync log for a specific bank |
| GET | `/api/statements` | All stored transactions |
| GET | `/api/statements?bank=alfabank&account=BY12...&from=2025-01-01&to=2025-01-31&limit=500` | Filtered transactions |
| POST | `/api/statements/refresh` | Trigger statement download for all configured accounts |
| POST | `/api/statements/refresh` (body: `{bank, account, dateFrom?, dateTo?}`) | Trigger for a specific account |
| GET | `/api/today-totals` | Today's credit/debit totals per account (grouped by bank, account, currency) |
| GET | `/api/statement-accounts` | List of accounts configured for statement syncing (from env vars) |
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

### Example: GET /api/today-totals

```json
{
  "totals": [
    { "bank": "alfabank", "accountNumber": "BY12ALFA...", "currency": "BYN", "totalCredit": 500.00, "totalDebit": 120.50 }
  ],
  "date": "2026-05-22"
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

Each bank adapter uses the strategy best suited to that bank's web application:

- **Alfa-Bank, Priorbank** — XHR/fetch response interception, with DOM scraping as fallback
- **БелВЭБ** — direct AJAX portlet fetch (`/Vpsk/List`), with Kendo Grid DOM scraping as fallback
- **Паритетбанк** — direct REST API calls (`/corporate/web-api/v1/`) via `page.evaluate(fetch(...))` using the session established by Playwright login; no DOM scraping required

Statement scraping stores transactions in the `transactions` table. After each successful import, if new transactions were found, a `POST` notification is sent to the configured 1C webhook.

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

Set `DEBUG_SCREENSHOTS=true` in `.env`, trigger a sync, then inspect the saved files in `./data/debug/`:

| Bank | Balance debug files | Statement debug files |
|---|---|---|
| Alfa-Bank | `alfabank-dashboard.html` / `.png` | `alfabank-statement-<account>.html` / `.png` |
| Priorbank | `priorbank-dashboard.html` / `.png` | `priorbank-statement-<account>.html` / `.png` |
| БелВЭБ | `belveb-dashboard.html` / `.png` | `belveb-stmt-<account>-<step>.html` / `.png` |
| Паритетбанк | `paritetbank-accounts-response.json` | `paritetbank-stmt-<account>-response.json` |

Update the relevant `src/banks/<bank>/accounts.ts` or `statements.ts` based on what the debug files reveal.

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
5. Register in `src/banks/index.ts` under a new env var (e.g. `NEWBANK_LOGIN`)
6. Add theming in `public/index.html`: CSS classes `.bank-<id>` and `.bank-card-<id>`, and entries in `bankLabel()` and `bankIcon()`
