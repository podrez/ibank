import { Page } from 'playwright';
import { LastPaymentOrderResult, PaymentOrder } from '../types';
import { logger } from '../../logger';
import { localToday } from '../../utils/dates';

const BASE_URL = 'https://www.ibank.priorbank.by';

/**
 * Ruble payment orders («9 - Рублевая платежка») live in the OLD cabinet's Kendo
 * portlet. Its list is a form POST guarded by an anti-forgery token, which the
 * portlet's Index HTML carries (and whose cookie the Index response sets).
 */
const PORTLET = `${BASE_URL}/v1/Bia.Portlets.Ib.Prior.Documents.Document9/Documents9`;

/** Ruble payment order — the bank's QueryTypeId for «Рублевая платежка». */
const QUERY_TYPE_RUB_PAYMENT = '9';

/** The newest documents to look at; the list comes back newest first. */
const PAGE_SIZE = 100;

interface RawDocument {
  DocumentNumber?: string | null;
  DateTimeIn?: string | null;
  LastStatusText?: string | null;
  Amount?: number | null;
  CurrCode?: number | null;
  AccountNumber?: string | null;
  RecipientName?: string | null;
  RecipientAccountNumber?: string | null;
  PaymentPurpose?: string | null;
  QueryId?: number | null;
}

interface ListResponse {
  Items?: RawDocument[];
  TotalCount?: number;
}

const CURRENCY_BY_CODE: Record<number, string> = { 933: 'BYN', 840: 'USD', 978: 'EUR', 643: 'RUB', 156: 'CNY' };

/**
 * Last outgoing ruble payment order number.
 *
 * "Last" is the **highest** number among this year's newest documents, not the
 * number of the newest one: the salary project files its own payment orders into
 * the same list and 1C's imports may reuse a number (on 18.11.2026 the bank's
 * salary order 2075 was followed by 1C's own 2075). Whoever numbers the next
 * order needs the maximum. Numbering restarts with the year, so only documents
 * created in the current calendar year count; before the first one of the year
 * the newest document overall is reported.
 *
 * All statuses count (drafts, rejected, executed): a number is taken once the
 * document exists.
 *
 * Runs over `context.request` — no page navigation, so it can safely run while
 * a scheduled sync is driving the bank's page.
 */
export async function getLastPaymentOrder(
  page: Page,
  opts: { account?: string } = {},
): Promise<LastPaymentOrderResult> {
  const docs = await listPaymentOrders(page);
  const relevant = opts.account ? docs.filter((d) => d.payerAccount === opts.account) : docs;

  const year = localToday().slice(0, 4);
  const thisYear = relevant.filter((d) => d.date.startsWith(year));

  let best: PaymentOrder | null = null;
  for (const d of thisYear) {
    if (!best || compareNumbers(d.number, best.number) > 0) best = d;
  }
  // Nothing this year yet → newest document overall (list is newest first)
  if (!best) best = relevant[0] ?? null;

  logger.info('[priorbank:payments] Last payment order resolved', {
    lastNumber: best?.number ?? null,
    examined: relevant.length,
    account: opts.account,
  });

  return { lastNumber: best?.number ?? null, document: best, examined: relevant.length };
}

/** The newest {@link PAGE_SIZE} ruble payment orders, newest first. */
export async function listPaymentOrders(page: Page): Promise<PaymentOrder[]> {
  const req = page.context().request;
  const headers = { 'X-Requested-With': 'XMLHttpRequest' };

  const index = await req.get(`${PORTLET}/Index?prtlId=prtl0&controller=&view=&title=`, { headers });
  const html = await index.text();
  const token = /name="__RequestVerificationToken"[^>]*value="([^"]+)"/.exec(html)?.[1];
  if (!token) {
    // A dead session serves the login page (200) instead of the portlet
    throw new Error(`[priorbank:payments] Session expired — no verification token (HTTP ${index.status()})`);
  }

  const today = localToday();
  const res = await req.post(`${PORTLET}/List`, {
    headers,
    form: {
      __RequestVerificationToken: token,
      QueryTypeId: QUERY_TYPE_RUB_PAYMENT,
      DocFilterRubVal: '1',
      DocFilterAccountCurrencyCode: '0',
      TabId: '0',
      Account: '',
      Status: '',
      Period: 'AllTime',
      'Periods.SelectedValue': 'AllTime',
      // Ignored for AllTime, but the form always sends them
      DateFrom: `${today}T00:00:00+03:00`,
      DateTo: `${today}T00:00:00+03:00`,
      PageNumber: '1',
      PageSize: String(PAGE_SIZE),
      Sorting: 'QueryId-desc',
      Filters: '',
    },
  });

  const text = await res.text();
  if (res.status() === 401 || res.status() === 403) {
    throw new Error(`[priorbank:payments] Session expired — List returned ${res.status()}`);
  }
  if (res.status() !== 200) {
    throw new Error(`[priorbank:payments] List returned HTTP ${res.status()}: ${text.slice(0, 200)}`);
  }

  let data: ListResponse;
  try {
    data = JSON.parse(text) as ListResponse;
  } catch {
    if (/<html|<!doctype/i.test(text)) throw new Error('[priorbank:payments] Session expired — List answered with HTML');
    throw new Error(`[priorbank:payments] List returned non-JSON: ${text.slice(0, 200)}`);
  }

  const items = data.Items ?? [];
  logger.debug('[priorbank:payments] Documents fetched', { returned: items.length, total: data.TotalCount });

  return items
    .filter((i) => (i.DocumentNumber ?? '').trim() !== '')
    .sort((a, b) => (b.QueryId ?? 0) - (a.QueryId ?? 0))
    .map(mapDocument);
}

function mapDocument(r: RawDocument): PaymentOrder {
  return {
    number: (r.DocumentNumber ?? '').trim(),
    date: (r.DateTimeIn ?? '').slice(0, 10),
    status: r.LastStatusText ?? '',
    amount: r.Amount ?? 0,
    currency: CURRENCY_BY_CODE[r.CurrCode ?? 933] ?? String(r.CurrCode ?? ''),
    payerAccount: r.AccountNumber ?? '',
    recipientName: r.RecipientName ?? undefined,
    recipientAccount: r.RecipientAccountNumber ?? undefined,
    purpose: r.PaymentPurpose ?? undefined,
  };
}

/** Numeric comparison when both are numbers, otherwise a natural string order. */
function compareNumbers(a: string, b: string): number {
  const na = /^\d+$/.test(a) ? Number(a) : NaN;
  const nb = /^\d+$/.test(b) ? Number(b) : NaN;
  if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
  if (!Number.isNaN(na)) return 1; // numeric numbers win over free-form ones
  if (!Number.isNaN(nb)) return -1;
  return a.localeCompare(b, 'ru', { numeric: true });
}
