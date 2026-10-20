export type Affordance = "button" | "safari-ios" | "safari-mac" | "none";

// Other browsers on iOS and macOS also say "Safari" in their user agent; only real Safari lacks
// these markers. The hint is a convenience, so a wrong guess costs one line of text.
const NOT_SAFARI = /Chrome|Chromium|CriOS|FxiOS|EdgiOS|Edg\/|OPiOS|OPR\//;

/** REQ-WEB-009: the browser's own prompt where it offers one, else a menu hint in Safari. */
export function installAffordance(input: {
  standalone: boolean;
  promptAvailable: boolean;
  userAgent: string;
}): Affordance {
  if (input.standalone) return "none";
  if (input.promptAvailable) return "button";
  const ua = input.userAgent;
  if (!/Safari\//.test(ua) || NOT_SAFARI.test(ua)) return "none";
  if (/iPhone|iPad|iPod/.test(ua)) return "safari-ios";
  return /Macintosh/.test(ua) && /Version\//.test(ua) ? "safari-mac" : "none";
}
