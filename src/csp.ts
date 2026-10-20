/**
 * The pages' Content Security Policy: everything from this origin only (REQ-WEB-006), `data:`
 * for the CSS-drawn location glyph, no framing. Shared by the Worker and the page the service
 * worker saves for offline, so both carry the same policy.
 */
export const PAGE_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");
