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

**Purpose**: Headless browser service that logs into multiple Belarusian banks, scrapes account balances every 5 minutes, persists them to SQLite, and exposes a REST API for consumption by a 1C accounting system. Corporate banks are scraped on weekdays 09:00–17:00 Minsk time; retail banks that operate 24/7 (adapter `roundTheClock`, e.g. iParitet) are scraped around the clock.

**Supported banks**: Alfa-Bank BY (`online.alfabank.by`), Priorbank BY (`www.ibank.priorbank.by`), БелВЭБ BY (`dbo2.bveb.by`), Паритетбанк BY corporate (`eparitet.by`), Паритетбанк физлица / iParitet (`iparitet.by`)

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
| `src/banks/paritetbank/` | Паритетбанк BY corporate adapter (auth + accounts + statements) |
| `src/banks/iparitet/` | Паритетбанк физлица / iParitet adapter — Angular SPA, bearer-token JSON API, session-only + interactive SMS login |
| `src/scraper/browser.ts` | Shared Chromium browser; one isolated context per bank |
| `src/scraper/index.ts` | Orchestrates syncAllBanks / syncBankBalances / syncAllStatements / syncBankStatement |
| `src/scheduler/index.ts` | Cron every INTERVAL min; retail (`roundTheClock`) banks 24/7, corporate banks Mon–Fri START–END hour; guards concurrent syncs |
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
| GET | `/api/accounts?bank=<id>` | Accounts for a specific bank (`alfabank`, `priorbank`, `belveb`, `paritetbank`, `iparitet`) |
| POST | `/api/refresh` | Force immediate sync (all banks) |
| POST | `/api/refresh?bank=<id>` | Force sync for a specific bank |
| GET | `/api/status` | Last sync info, account count |
| GET | `/api/sync-log` | Last 20 sync log entries |
| GET | `/api/sync-log?bank=<id>` | Sync log for a specific bank |
| GET | `/api/statements` | All stored transactions |
| GET | `/api/statements?bank=alfabank&account=BY12...&from=2025-01-01&to=2025-01-31&limit=500` | Filtered transactions |
| POST | `/api/statements/refresh` | Trigger statement download for all configured accounts |
| POST | `/api/statements/refresh` (body: `{bank, account, dateFrom?, dateTo?}`) | Trigger for a specific account |
| GET | `/api/auth` | Banks supporting interactive (SMS) login, with stage + saved-session flag |
| GET | `/api/auth/<bank>/status` | Interactive-login stage (`idle`/`awaiting_sms`) and whether a session is saved |
| POST | `/api/auth/<bank>/start` | Begin operator-driven login (fills creds, triggers SMS) |
| POST | `/api/auth/<bank>/sms` (body: `{code}`) | Submit the SMS code for a pending login |
| POST | `/api/auth/<bank>/cancel` | Abort a pending interactive login |
| GET | `/health` | Health check (no auth) |

### Interactive SMS login (Alfa-Bank)

Alfa-Bank BY asks for an SMS one-time code only when it challenges a new
device/session — once that has been confirmed, an ordinary login/password sign-in
goes straight through. The session dies overnight, so:

- Automated `login()` in `src/banks/alfabank/auth.ts` first reuses the session
  persisted to `./data/sessions/<bank>.json` (cookies + localStorage) and, if that
  is gone, **submits credentials** and waits for the cabinet.
- If the bank actually holds on the SMS prompt (or rejects the credentials),
  `login()` throws `ReauthRequiredError` (`src/auth/interactive.ts`) **and blocks
  further automatic login attempts** for `AUTO_LOGIN_BLOCK_MS` (6 h) — so a cron
  tick can never fire an SMS (or a bad-password attempt) every cycle. The block is
  lifted by a successful interactive login or by `resetSession()` (credentials
  changed).
- An operator restores access from the settings UI (Банки → «Вход по SMS»): the
  two-step flow (`/api/auth/alfabank/start` → `/api/auth/alfabank/sms`) fills
  credentials, waits for the bank's SMS, accepts the code, and persists the session.
- Session persistence lives in `src/scraper/browser.ts` (`saveSession` /
  `clearSession` / `hasSavedSession`); contexts are created with `storageState` when a
  saved file exists. Changing a bank's credentials clears its saved session.

The SMS-page selectors (`SMS_INPUT_SELECTORS` / `SMS_CONFIRM_SELECTORS` in
`alfabank/auth.ts`) are **best-effort** — calibrate against `./data/debug/alfabank-sms-*.html`
(set `DEBUG_SCREENSHOTS=true`) if the code field / confirm button aren't found.

### iParitet (Паритетбанк физлица)

iParitet (`src/banks/iparitet/`) is an Angular SPA with a bearer-token JSON API
(`/core/services/v3`, `/auth/services/v3`). The token lives in `localStorage`
(`auth.sessionToken`) and is persisted via `storageState`.

A normal login/password sign-in does **not** require an SMS on this account, so
automated `login()` reuses the persisted session and, if it is gone, submits
credentials and waits for the dashboard (`fillAndSubmitCredentials`). The SPA's
default login always routes through `/auth/registration/code`, but when no SMS is
needed that page auto-redirects to the dashboard within a second or two — so
`waitForSmsOrDashboard` lets the dashboard win and only concludes `awaiting_sms` if
the code route *persists* past an 8 s grace period. **Do not** put the generic
`app-control-field__input` class in the SMS-detection selectors — it is shared with
the login/password fields and caused a false "SMS required" the instant the form
rendered. If the bank ever genuinely holds on the code page (a new-device
challenge), `login()` throws `ReauthRequiredError` and an operator completes the SMS
once via the settings UI (Банки → «Вход по SMS», `/api/auth/iparitet/start` →
`.../sms`). The scheduler **skips** a bank while its interactive SMS login is
mid-flow (`getInteractiveAuth(id).status() === 'awaiting_sms'`), so a sync tick's
`resetContext()` can't close the pending SMS page.

`isLoggedIn()` is **route-based** (URL is under `/app`) and deliberately does *not*
require the token: the SPA reaches the dashboard a moment before ngxs flushes the
token into sessionStorage, and gating login on it made login appear to never
complete.

**Token acquisition must not depend on storage.** sessionStorage intermittently
never received the token within the wait window in production, so `attachTokenCapture(page)`
(called on the page *before* navigating) sniffs `Authorization: Bearer …` off the
SPA's own `/services/v3` requests, and `waitForSessionToken()` prefers that captured
value, falling back to sessionStorage/localStorage. `readSessionToken` also filters
the literal string `"undefined"` the SPA parks in those slots pre-login.

**Scraping does not touch the DOM** — it reads the bearer token and calls the JSON
API directly (`src/banks/iparitet/api.ts`). The token is in **sessionStorage** under
`auth.sessionToken` (NOT localStorage, and NOT captured by `storageState` — so after
a restart the scraper just re-logs-in with credentials). Endpoints (verified against
a live login):
- `GET /core/services/v3/product/get-products?getCreditDetail=false` → `{cardAccount[], currentAccount[]}`.
  **Card balances are nested**: `cardAccount[].cards[].balance` (+ `currency`,
  `cardNumberMasked`); the card account's own number is `accountNumber`/`ibanNum` and
  its statement key is `contractNumberHash`. Current accounts carry `balanceAmount`.
- `POST /core/services/v3/operation/history/get-operations-history`
  (`{dateFrom, dateTo, contractNumberHash?}`, ms timestamps) → `{operationHistory[]}`.
  Each op: `paymentDate` (ms), `amount` (sign = direction: −=debit/Списание,
  +=credit/Зачисление), `currency` (alphabetic), `payName`, `payCode`, `operationId`, `rrn`.

The bank occasionally answers a `200` with a **non-JSON body**. `apiCall` treats that
as a failure (with a body snippet in `error`) rather than "no accounts", and scrapers
use `apiCallWithRetry` (one retry after 2 s) so a transient blip doesn't fail the cycle.

Login form selectors (`LOGIN/PASSWORD/SUBMIT` in `iparitet/auth.ts`): the inner
`<input>` of the `<app-text-input>` component carries class `app-control-field__input`,
a **random** `id`, an empty `type=""` for the login field, and binds its control via
`[formControl]` (no `formcontrolname` attribute) — so match by class, not by
name/type/formcontrolname. Raw JSON is dumped to `./data/debug/iparitet-*.json` when
`DEBUG_SCREENSHOTS=true`.

### Priorbank: two cabinets, one session

Priorbank runs **two** front-ends side by side on the same session cookie:

- **Old cabinet** — `/v1/…`, Kendo UI, server-rendered. Still serves the desktop, and
  **balances are scraped here** (`accounts.ts` intercepts the
  `/v1/…/AccountsWidget/GetAccounts` XHR).
- **New cabinet** — `/Cabinet/…`, React/Ant Design SPA with a JSON API under `/v2/`.
  **Statements live here** (`statements.ts`).

`isLoggedIn()` therefore accepts *both* `/v1/` and `/Cabinet/` URLs. Menu ids are
**not stable**: the statement page used to be `/v1/Cabinet/101`, that id no longer
resolves, and the bank silently serves the desktop instead — which surfaced as
"0 transactions" every cycle rather than as an error. Do not hard-code a menu id;
call the API.

Statement flow (`src/banks/priorbank/statements.ts`) — all `fetch` from inside the
page so the session cookie is attached, no DOM scraping:
- `GET /v2/Accounts/GetAccountsLookup` → `{accTitle, accNumber, currCode, rubVal}[]`.
  `GetStatementData` needs this whole descriptor, not just the account number.
- `POST /v2/Accounts/GetStatementData` with
  `{accData, dateFrom, dateTo, isNazn:1, isKor:1, isRevaluation:1, sortByAmount:1}`.
  Dates are `yyyy-MM-ddT00:00:00+03:00` (Minsk is UTC+3 year-round). The `is*` flags
  mirror the UI's "Дополнительно" checkboxes — without them the response drops the
  payment purpose and the counterparty name.
- Response: `{generalInfo[], accountSummaries[], transactions[]}`. Each transaction:
  `docDate` (dd.mm.yyyy), `docN`, `dbAmount`/`crAmount` (display strings — `"10 931.50"`,
  space-separated thousands), `naznText`, `iso`, `corrName`, `unp`, `corrAccount`, `opr`.
  `accountSummaries` carries opening/turnover/closing balances (useful for reconciling).
- The range limit is `GET /v2/Accounts/GetMaxStatementRangeInDays` (186 days).
- A dead session answers `200` with an HTML login page; `apiCall` raises
  "Session expired" on that so the caller re-logs in instead of storing zero rows.

Other useful `/v2/` endpoints seen in the new cabinet: `User/CheckSessionAlive`,
`User/GetUserMenu`, `Accounts/GetAccountList` (balances, if the old cabinet ever dies).

### Scraper selector adjustment

If a bank's scraper can't find account cards (DOM scraping path), set `DEBUG_SCREENSHOTS=true` in `.env`. Each bank saves its debug files with a bank prefix:
- Alfa-Bank: `./data/debug/alfabank-dashboard.html` / `./data/debug/alfabank-dashboard.png`
- Priorbank: `./data/debug/priorbank-dashboard.html` / `./data/debug/priorbank-dashboard.png`
- БелВЭБ: `./data/debug/belveb-dashboard.html` / `./data/debug/belveb-dashboard.png`
- Паритетбанк: `./data/debug/paritetbank-accounts-response.json`
- iParitet: `./data/debug/iparitet-accounts-response.json`

Update `domScrape()` in the relevant `src/banks/<bank>/accounts.ts`.

### Scraper selector adjustment (statements)

If statement scraping fails (DOM fallback), set `DEBUG_SCREENSHOTS=true`. Each bank saves:
- `./data/debug/alfabank-statement-<account>.html` / `.png`
- `./data/debug/priorbank-stmt-<account>-response.json`
- `./data/debug/belveb-statement-<account>.html` / `.png`
- `./data/debug/paritetbank-stmt-<account>-response.json`
- `./data/debug/iparitet-stmt-<account>-response.json`

Update `domScrape()` in the relevant `src/banks/<bank>/statements.ts`.

### Environment variables

Defined in `.env.example`. Key variables:
- `ALFABANK_LOGIN`, `ALFABANK_PASSWORD` — Alfa-Bank credentials (also accepts legacy `BANK_LOGIN`/`BANK_PASSWORD`)
- `PRIORBANK_LOGIN`, `PRIORBANK_PASSWORD` — Priorbank credentials
- `BELVEB_LOGIN`, `BELVEB_PASSWORD` — БелВЭБ credentials
- `PARITETBANK_LOGIN`, `PARITETBANK_PASSWORD` — Паритетбанк credentials
- `PARITETBANK_ORG` — (optional) org name to select if the account has multiple organisations
- `IPARITET_LOGIN`, `IPARITET_PASSWORD` — iParitet (Паритетбанк физлица) credentials; SMS login required
- A bank is **enabled** when its LOGIN env var is set
- `ALFABANK_STATEMENT_ACCOUNTS` — comma-separated account numbers for automatic statement sync
- `PRIORBANK_STATEMENT_ACCOUNTS` — same for Priorbank
- `BELVEB_STATEMENT_ACCOUNTS` — same for БелВЭБ
- `PARITETBANK_STATEMENT_ACCOUNTS` — same for Паритетбанк
- `IPARITET_STATEMENT_ACCOUNTS` — same for iParitet (card/account contract numbers)
- `API_KEY` — protects the REST API
- `SESSION_DIR` — (optional) where per-bank browser sessions are persisted (default `./data/sessions`)
- `DEBUG_SCREENSHOTS=true` — saves Playwright screenshots/HTML per bank
- `HEADLESS=false` — run Chromium in headed mode for local debugging
