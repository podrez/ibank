/** Pick first non-null value from obj by trying keys in order, return '' if none found. */
export function strPick(obj: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) if (obj[k] != null) return String(obj[k]);
  return '';
}

/** Pick first parseable number from obj by trying keys in order, return null if none found. */
export function numPick(obj: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const v = parseFloat(String(obj[k] ?? ''));
    if (!isNaN(v)) return v;
  }
  return null;
}
