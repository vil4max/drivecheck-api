// SVG drawings in the spirit of the SF Symbols the iOS Status screen uses; SF Symbols themselves
// may not ship on the web. Inline, so the page needs no image request; colour is currentColor.

export type Glyph =
  | "check"
  | "exclamation"
  | "triangle"
  | "clock"
  | "question"
  | "location"
  | "refresh"
  | "back"
  | "chevron"
  | "offline";

const PATHS: Record<Glyph, string> = {
  check:
    '<path d="M7 12.5l3.2 3.2L17 9" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>',
  exclamation:
    '<path d="M12 6.5v7" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/><circle cx="12" cy="17.5" r="1.6" fill="currentColor"/>',
  triangle:
    '<path d="M10.3 3.9 2.4 17.6A2 2 0 0 0 4.1 20.6h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" fill="currentColor"/><path d="M12 9v4.5" stroke="#0C0E11" stroke-width="2.2" stroke-linecap="round"/><circle cx="12" cy="17" r="1.3" fill="#0C0E11"/>',
  clock:
    '<circle cx="12" cy="12" r="7.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 8v4.3l2.8 1.8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  question:
    '<path d="M9.2 9.3a2.9 2.9 0 1 1 4.3 2.5c-.9.5-1.5 1.1-1.5 2.2v.4" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round"/><circle cx="12" cy="17.6" r="1.4" fill="currentColor"/>',
  location: '<path d="M21 3 3 10.5l7.6 2.9L13.5 21z" fill="currentColor"/>',
  refresh:
    '<path d="M19 12a7 7 0 1 1-2.05-4.95" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M17.5 3.5v4h-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  back: '<path d="M15 5 8 12l7 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>',
  chevron:
    '<path d="m9 5 7 7-7 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>',
  offline:
    '<path d="M2.5 9a14 14 0 0 1 19 0M5.5 12.5a9.5 9.5 0 0 1 13 0M9 16a4.5 4.5 0 0 1 6 0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M4 3l16 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
};

/** An inline SVG glyph, hidden from assistive technology: the text beside it carries meaning. */
export function glyph(name: Glyph, className = ""): string {
  const cls = className === "" ? "" : ` class="${className}"`;
  return `<svg${cls} viewBox="0 0 24 24" aria-hidden="true" focusable="false" data-glyph="${name}">${PATHS[name]}</svg>`;
}
