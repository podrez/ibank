/**
 * Parse a raw date string from any of the formats used by Belarusian bank APIs:
 *   - ISO yyyy-MM-dd or yyyy-MM-ddTHH:mm:ss...
 *   - DD.MM.YYYY
 *   - Unix timestamp in seconds (10 digits) or milliseconds (13 digits)
 * Returns ISO yyyy-MM-dd or null if unrecognised.
 */
export function parseDate(raw: string): string | null {
  if (!raw) return null;
  const iso = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  if (iso) return iso[1];
  const dmy = raw.match(/^(\d{2})\.(\d{2})\.(\d{4})/);
  if (dmy) return `${dmy[3]}-${dmy[2]}-${dmy[1]}`;
  if (/^\d{10,13}$/.test(raw)) {
    const ts = Number(raw);
    // 10-digit = seconds, 13-digit = milliseconds
    const d = new Date(ts > 9_999_999_999 ? ts : ts * 1000);
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  return null;
}

/** Convert ISO yyyy-MM-dd to DD.MM.YYYY (used for BIA portal form inputs). */
export function isoToDMY(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}

/** Today's date as ISO yyyy-MM-dd (UTC). */
export function isoToday(): string {
  return new Date().toISOString().slice(0, 10);
}
