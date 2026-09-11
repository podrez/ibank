import { Page } from 'playwright';
import { logger } from '../../logger';

const API_BASE = '/corporate/web-api/v1';

// new.eparitet.by answers `Keep-Alive: timeout=15` and then silently drops idle
// connections (no FIN/RST). Chrome keeps them pooled, and the next request written
// to one hangs ~2 min before the browser gives up and reconnects — so every
// scheduler tick, 5 min after the previous one, stalled on its first API call.
//
// Chrome keeps at most 6 connections per HTTP/1.1 host. Firing 6 cheap requests at
// once takes every pooled socket; aborting the ones that hang closes them, so the
// real API calls that follow run on fresh connections.
const POOL_SIZE = 6;
const PROBE_TIMEOUT_MS = 4_000;

export async function dropStaleConnections(page: Page): Promise<void> {
  const dropped = await page.evaluate(async ({ apiBase, poolSize, timeoutMs }) => {
    const outcomes = await Promise.all(Array.from({ length: poolSize }, async () => {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      try {
        const res = await fetch(`${apiBase}/info/getSettings`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          signal: ac.signal,
        });
        await res.text();
        return true;
      } catch {
        return false;
      } finally {
        clearTimeout(timer);
      }
    }));
    return outcomes.filter((ok) => !ok).length;
  }, { apiBase: API_BASE, poolSize: POOL_SIZE, timeoutMs: PROBE_TIMEOUT_MS }).catch(() => 0);

  if (dropped > 0) logger.debug('[paritetbank] Dropped stale connections', { dropped });
}
