# Account Balances Service

Headless browser service that logs into multiple Belarusian banks, scrapes account balances every 5 minutes on weekdays (09:00–17:00 Minsk time), persists them to SQLite, and exposes a REST API for consumption by a 1C accounting system.

**Supported banks:** Alfa-Bank BY (`online.alfabank.by`), Priorbank BY (`www.ibank.priorbank.by`)

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
cp .env.example .env
# Edit .env

docker compose up --build -d
docker compose logs -f
```

The service is available at `http://localhost:3000`.

## Environment variables

A bank is **enabled** when its `LOGIN` env var is set. Leave it empty to disable that bank.

| Variable | Default | Description |
|---|---|---|
| `ALFABANK_LOGIN` | — | Alfa-Bank BY login (leave empty to disable) |
| `ALFABANK_PASSWORD` | — | Alfa-Bank BY password |
| `PRIORBANK_LOGIN` | — | Priorbank BY login (leave empty to disable) |
| `PRIORBANK_PASSWORD` | — | Priorbank BY password |
| `DB_PATH` | `./data/accounts.db` | Path to SQLite database file |
| `API_PORT` | `3000` | HTTP port for the REST API |
| `API_KEY` | — | Secret key to protect the API |
| `SCHEDULE_START_HOUR` | `9` | Scraping window start hour (Minsk time) |
| `SCHEDULE_END_HOUR` | `17` | Scraping window end hour (Minsk time) |
| `SCHEDULE_INTERVAL_MINUTES` | `5` | Interval between scrapes (minutes) |
| `EXTRA_WORKING_DAYS` | — | Comma-separated dates (`YYYY-MM-DD`) that are working days despite falling on Sat/Sun (e.g. `2026-04-25,2026-11-07`) |
| `ALFABANK_STATEMENT_ACCOUNTS` | — | Comma-separated account numbers for automatic statement sync |
| `PRIORBANK_STATEMENT_ACCOUNTS` | — | Same for Priorbank |
| `ONEC_WEBHOOK_URL` | — | 1C webhook URL to notify on new transactions (leave empty to disable) |
| `ONEC_USERNAME` | — | Basic auth username for 1C |
| `ONEC_PASSWORD` | — | Basic auth password for 1C |
| `ONEC_API_KEY` | — | Value sent in the `X-Api-Key` header to 1C |
| `HEADLESS` | `true` | Run Chromium headless (`false` for local debug) |
| `BROWSER_TIMEOUT_MS` | `30000` | Playwright navigation timeout (ms) |
| `DEBUG_SCREENSHOTS` | `false` | Save screenshots/HTML to `./data/debug/` per bank |
| `LOG_LEVEL` | `info` | Winston log level |

## REST API

All endpoints (except `/health`) require authentication via one of:
- `X-Api-Key: <key>` header
- `Authorization: Bearer <key>` header

| Method | Path | Description |
|---|---|---|
| GET | `/api/accounts` | All accounts with latest balances |
| GET | `/api/accounts?bank=alfabank` | Accounts for a specific bank |
| POST | `/api/refresh` | Force immediate balance sync (all banks) |
| POST | `/api/refresh?bank=priorbank` | Force sync for a specific bank |
| GET | `/api/status` | Last sync info, account count, server time |
| GET | `/api/sync-log` | Last 20 sync log entries |
| GET | `/api/sync-log?bank=alfabank` | Sync log for a specific bank |
| GET | `/api/statements` | All stored transactions |
| GET | `/api/statements?bank=alfabank&account=BY12...&from=2025-01-01&to=2025-01-31&limit=500` | Filtered transactions |
| POST | `/api/statements/refresh` | Trigger statement download for all configured accounts |
| POST | `/api/statements/refresh` (body: `{bank, account, dateFrom?, dateTo?}`) | Trigger for a specific account |
| GET | `/health` | Health check (no auth required) |

### Example: GET /api/accounts

```json
{
  "accounts": [
    {
      "bank": "alfabank",
      "accountNumber": "BY12ALFA...",
      "currency": "BYN",
      "balance": "1234.56",
      "available": "1234.56",
      "updatedAt": "2024-01-15T10:00:05.000Z"
    }
  ],
  "count": 3
}
```

## Architecture

```
Scheduler (node-cron)
  └─► scraper/index.ts (syncAllBanks / syncAllStatements)
        └─► for each enabled bank:
              ├─► banks/<bank>/auth.ts      — Playwright login
              ├─► banks/<bank>/accounts.ts  — Scrape balances (API intercept → DOM fallback)
              │     └─► db/index.ts         — Persist to SQLite (keyed by bank + accountNumber)
              │           └─► GET /api/accounts — Served to 1C
              └─► banks/<bank>/statements.ts — Scrape transactions (API intercept → DOM fallback)
                    └─► db/index.ts          — Persist to SQLite (transactions table)
                          └─► notify/onec.ts — POST to 1C webhook on new imports
```

The scraper first attempts to intercept XHR/fetch responses matching the bank's internal API patterns. If that yields nothing, it falls back to DOM scraping with multiple CSS selector strategies.

Statement scraping works the same way and stores transactions in the `transactions` table. After each successful import, if new transactions were found, a `POST` notification is sent to the configured 1C webhook.

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

If a bank's scraper fails to find account cards via DOM scraping:

1. Set `DEBUG_SCREENSHOTS=true` in `.env`
2. Trigger a sync and inspect the saved files:
   - `./data/debug/alfabank-dashboard.html` / `alfabank-dashboard.png`
   - `./data/debug/priorbank-dashboard.html` / `priorbank-dashboard.png`
3. Update CSS selectors in `domScrape()` inside the relevant `src/banks/<bank>/accounts.ts`

For statement scraping failures, the debug files are named `<bank>-statement-<account>.html/.png`.

## 1C notifications

When `ONEC_WEBHOOK_URL` is set, the service sends a `POST` request to that URL after each statement sync that imports at least one new transaction.

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
