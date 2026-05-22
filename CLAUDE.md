# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install                # Install dependencies
npm run dev                # Run in dev mode (tsx watch)
npm run build              # Compile TypeScript to dist/
npm start                  # Run compiled build

npm run db:generate        # Generate Drizzle migrations after schema changes
npm run db:migrate         # Apply migrations to SQLite

docker compose up --build  # Build and start in Docker
docker compose logs -f     # Follow logs
```

## Architecture

**Purpose**: Headless browser service that logs into multiple Belarusian banks, scrapes account balances every 5 minutes on weekdays 09:00–17:00 Minsk time, persists them to SQLite, and exposes a REST API for consumption by a 1C accounting system.

**Supported banks**: Alfa-Bank BY (`online.alfabank.by`), Priorbank BY (`www.ibank.priorbank.by`), БелВЭБ BY (`dbo2.bveb.by`), Паритетбанк BY (`eparitet.by`)

**Tech stack**: Node.js + TypeScript, Playwright (Chromium), Drizzle ORM + better-sqlite3 (SQLite), Express, node-cron, Docker.

### Data flow

```
Scheduler (node-cron)
  └─► scraper/index.ts (syncAllBanks)
        └─► for each enabled bank:
              ├─► banks/<bank>/auth.ts   — Playwright login
              └─► banks/<bank>/accounts.ts — Scrape balances (API intercept → DOM fallback)
                    └─► db/index.ts  — Persist to SQLite (keyed by bank + accountNumber)
                          └─► API /api/accounts — Served to 1C
```

### Key modules

| File | Role |
|------|------|
| `src/banks/types.ts` | `BankAdapter` interface, `ScrapedAccount`, `ScrapedTransaction`, `StatementRequest` types |
| `src/banks/index.ts` | Registry — returns enabled banks based on env vars |
| `src/banks/alfabank/` | Alfa-Bank BY adapter (auth + accounts + statements) |
| `src/banks/priorbank/` | Priorbank BY adapter (auth + accounts + statements) |
| `src/banks/belveb/` | БелВЭБ BY adapter (auth + accounts + statements) |
| `src/banks/paritetbank/` | Паритетбанк BY adapter (auth + accounts + statements) |
| `src/scraper/browser.ts` | Shared Chromium browser; one isolated context per bank |
| `src/scraper/index.ts` | Orchestrates syncAllBanks / syncBankBalances / syncAllStatements / syncBankStatement |
| `src/scheduler/index.ts` | Cron job Mon–Fri, UTC+3, guards concurrent syncs |
| `src/api/routes.ts` | Express routes with `X-Api-Key` / `Authorization: Bearer` auth |
| `src/db/schema.ts` | Tables: `accounts`, `sync_log`, `transactions` |

### Adding a new bank

1. Create `src/banks/<bankid>/auth.ts` — `login(): Promise<Page>` and `isLoggedIn(page): Promise<boolean>`
2. Create `src/banks/<bankid>/accounts.ts` — `scrapeAccounts(page): Promise<ScrapedAccount[]>`
3. Create `src/banks/<bankid>/statements.ts` — `scrapeStatement(page, req): Promise<ScrapedTransaction[]>` (optional)
4. Create `src/banks/<bankid>/index.ts` — class implementing `BankAdapter`
5. Register in `src/banks/index.ts` under a new env var (e.g. `NEWBANK_LOGIN`)

### REST API endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/accounts` | All accounts with latest balance |
| GET | `/api/accounts?bank=alfabank` | Accounts for a specific bank |
| POST | `/api/refresh` | Force immediate sync (all banks) |
| POST | `/api/refresh?bank=priorbank` | Force sync for a specific bank |
| GET | `/api/status` | Last sync info, account count |
| GET | `/api/sync-log` | Last 20 sync log entries |
| GET | `/api/sync-log?bank=alfabank` | Sync log for a specific bank |
| GET | `/api/statements` | All stored transactions |
| GET | `/api/statements?bank=alfabank&account=BY12...&from=2025-01-01&to=2025-01-31&limit=500` | Filtered transactions |
| POST | `/api/statements/refresh` | Trigger statement download for all configured accounts |
| POST | `/api/statements/refresh` (body: `{bank, account, dateFrom?, dateTo?}`) | Trigger for a specific account |
| GET | `/health` | Health check (no auth) |

### Scraper selector adjustment

If a bank's scraper can't find account cards (DOM scraping path), set `DEBUG_SCREENSHOTS=true` in `.env`. Each bank saves its debug files with a bank prefix:
- Alfa-Bank: `./data/debug/alfabank-dashboard.html` / `./data/debug/alfabank-dashboard.png`
- Priorbank: `./data/debug/priorbank-dashboard.html` / `./data/debug/priorbank-dashboard.png`
- БелВЭБ: `./data/debug/belveb-dashboard.html` / `./data/debug/belveb-dashboard.png`
- Паритетбанк: `./data/debug/paritetbank-accounts-response.json`

Update `domScrape()` in the relevant `src/banks/<bank>/accounts.ts`.

### Scraper selector adjustment (statements)

If statement scraping fails (DOM fallback), set `DEBUG_SCREENSHOTS=true`. Each bank saves:
- `./data/debug/alfabank-statement-<account>.html` / `.png`
- `./data/debug/priorbank-statement-<account>.html` / `.png`
- `./data/debug/belveb-statement-<account>.html` / `.png`
- `./data/debug/paritetbank-stmt-<account>-response.json`

Update `domScrape()` in the relevant `src/banks/<bank>/statements.ts`.

### Environment variables

Defined in `.env.example`. Key variables:
- `ALFABANK_LOGIN`, `ALFABANK_PASSWORD` — Alfa-Bank credentials (also accepts legacy `BANK_LOGIN`/`BANK_PASSWORD`)
- `PRIORBANK_LOGIN`, `PRIORBANK_PASSWORD` — Priorbank credentials
- `BELVEB_LOGIN`, `BELVEB_PASSWORD` — БелВЭБ credentials
- `PARITETBANK_LOGIN`, `PARITETBANK_PASSWORD` — Паритетбанк credentials
- `PARITETBANK_ORG` — (optional) org name to select if the account has multiple organisations
- A bank is **enabled** when its LOGIN env var is set
- `ALFABANK_STATEMENT_ACCOUNTS` — comma-separated account numbers for automatic statement sync
- `PRIORBANK_STATEMENT_ACCOUNTS` — same for Priorbank
- `BELVEB_STATEMENT_ACCOUNTS` — same for БелВЭБ
- `PARITETBANK_STATEMENT_ACCOUNTS` — same for Паритетбанк
- `API_KEY` — protects the REST API
- `DEBUG_SCREENSHOTS=true` — saves Playwright screenshots/HTML per bank
- `HEADLESS=false` — run Chromium in headed mode for local debugging
