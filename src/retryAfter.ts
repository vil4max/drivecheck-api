/** The longest any 429 holds requests back, so a broken or hostile header cannot silence the API. */
export const MAX_HOLD_MS = 5 * 60_000;
const BACKOFF_START_MS = 30_000;

/** When upstream requests may resume after the `attempt`-th consecutive HTTP 429 (REQ-REFRESH-005). */
export function rateLimitDeadline(header: string | null, now: number, attempt: number): number {
  const requested = header === null ? null : requestedDeadline(header.trim(), now);
  if (requested !== null) return Math.min(Math.max(requested, now), now + MAX_HOLD_MS);
  const backoff = BACKOFF_START_MS * 2 ** Math.max(0, attempt - 1);
  return now + Math.min(backoff, MAX_HOLD_MS);
}

function requestedDeadline(header: string, now: number): number | null {
  if (/^-?\d+(\.\d+)?$/.test(header)) return now + Number(header) * 1000;
  // Only an HTTP date carries a weekday and "GMT"; a bare word must not parse as a date.
  if (!/GMT$/.test(header)) return null;
  const date = Date.parse(header);
  return Number.isFinite(date) ? date : null;
}
