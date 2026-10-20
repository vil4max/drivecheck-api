import { describe, expect, test } from "vitest";
import { STRINGS } from "../src/i18n";
import { renderOffline, renderPage } from "../src/page";
import { type Lang, regionById } from "../src/regions";
import { renderRegions } from "../src/regionsPage";
import { ACCENT, contrastRatio, over, PALETTE, STYLESHEET, SURFACE } from "../src/theme";
import { regionsModel, staleAt, statusModel } from "../src/view";
import { snapshotWith, T0 } from "./support";

const key = (id: string) => regionById(id)!.apiKey;
const region = (id: string) => regionById(id)!;
const model = (alarmIds: string[], id = "kyiv-city", now = T0, lang: Lang = "en") =>
  statusModel(snapshotWith(alarmIds.map(key)), region(id), lang, now, T0 - 120_000);

describe("Status model in the iOS design", () => {
  test("REQ-WEB-011 title, accent and glyph per status, as the iOS hero", () => {
    expect(model(["kyiv-city"])).toMatchObject({
      title: "Air Raid Alert",
      accent: "alert",
      symbol: "exclamation",
    });
    expect(model([])).toMatchObject({ title: "No Alert", accent: "clear", symbol: "check" });
    expect(model([], "kyiv-city", T0 + 120_001)).toMatchObject({
      title: "No Alert",
      accent: "stale",
      symbol: "clock",
    });
    // A known alarm stays red when old.
    expect(model(["kyiv-city"], "kyiv-city", T0 + 600_000)).toMatchObject({
      accent: "alert",
      symbol: "exclamation",
    });
    const none = statusModel(null, region("kyiv-city"), "en", T0, null);
    expect(none).toMatchObject({ title: "Unavailable", accent: "unavailable", symbol: "question" });
  });

  test("REQ-SURF-010 a surrounded quiet region reads Stay Alert in yellow", () => {
    expect(model(["kyiv-oblast"])).toMatchObject({
      title: "Stay Alert",
      accent: "caution",
      symbol: "triangle",
    });
    expect(model(["kyiv-oblast"], "kyiv-city", T0, "uk").title).toBe("Будьте уважні");
    expect(model(["kyiv-oblast"], "kyiv-city", T0 + 120_001).accent).toBe("stale");
  });

  test("REQ-REFRESH-006 the meta line: updated time, or last known with the status when stale", () => {
    expect(model([]).meta).toBe("Updated 12:00");
    expect(model([], "kyiv-city", T0 + 120_001).meta).toBe("Last known: No Alert · 12:00");
    expect(model(["kyiv-city"], "kyiv-city", T0 + 600_000, "ru").meta).toBe(
      "Последнее известное: Воздушная тревога · 12:00",
    );
  });

  test("REQ-SURF-005 the nearby card names at most two neighbours, then +N", () => {
    expect(model(["kyiv-oblast", "chernihiv"]).nearby).toBe(
      "Nearby: Kyiv Oblast, Chernihiv Oblast",
    );
    expect(model(["kyiv-oblast", "chernihiv", "zhytomyr", "poltava"]).nearby).toBe(
      "Nearby: Kyiv Oblast, Chernihiv Oblast +2",
    );
    expect(model(["lviv"]).nearby).toBeNull();
  });

  test("REQ-REGION-001 a region the feed lacks reads Region Unavailable with its own hint", () => {
    const snapshot = snapshotWith([], [key("kyiv-city")]);
    const m = statusModel(snapshot, region("kyiv-city"), "en", T0, null);
    expect(m).toMatchObject({ title: "Region Unavailable", accent: "unavailable" });
    expect(m.meta).toBe("Pick another region or refresh");
  });

  test("REQ-WEB-012 the map caption counts regions now and ages from the map's own time", () => {
    const m = statusModel(
      snapshotWith(["kyiv-city", "lviv", "odesa", "sumy"].map(key)),
      region("kyiv-city"),
      "en",
      T0,
      T0 - 120_000,
    );
    expect(m.mapCaption).toBe("4 of 25 regions under alert · 2 min ago");
    expect(m.mapLabel).toBe(
      "Alert map. Regions in alert (4): Kyiv, Lviv Oblast, Odesa Oblast, Sumy Oblast",
    );
    expect(model([]).mapLabel).toBe("Alert map. All regions clear.");
    const noTime = statusModel(snapshotWith([]), region("kyiv-city"), "en", T0, null);
    expect(noTime.mapCaption).toBe("0 of 25 regions under alert");
    const old = statusModel(snapshotWith([]), region("kyiv-city"), "en", T0, T0 - 7_200_000);
    expect(old.mapCaption).toBe("0 of 25 regions under alert · 2 h ago");
  });
});

describe("Status page", () => {
  const html = (alarmIds: string[] = [], lang: Lang = "en") =>
    renderPage(model(alarmIds, "kyiv-city", T0, lang));

  test("REQ-WEB-011 renders the iOS composition: toolbar, radar hero, status, region, meta, nearby, map", () => {
    const page = html(["kyiv-oblast", "kyiv-city"]);
    expect(page).toContain('class="title">Drive Check<');
    expect(page.match(/class="tick"/g)).toHaveLength(60);
    expect(page).toContain('data-glyph="exclamation"');
    expect(page).toMatch(/<body class="accent-alert"/);
    const order = [
      "radar",
      "<h1",
      'class="region"',
      'class="meta"',
      'class="card nearby"',
      'class="card map"',
      "informational",
    ].map((marker) => page.indexOf(marker));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(page.match(/<h1[\s>]/g)).toHaveLength(1);
  });

  test("REQ-WEB-005 the page is complete without its script", () => {
    const page = html(["kyiv-oblast"]).replace(/<script[^>]*><\/script>/g, "");
    expect(page).toMatch(/<h1[^>]*>Stay Alert<\/h1>/);
    expect(page).toContain("Updated 12:00");
    expect(page).toContain("Nearby: Kyiv Oblast");
    expect(page).toContain("background-image:url(/v1/map)");
    expect(page).toMatch(/<a[^>]+href="\/regions\?lang=en"[^>]*class="card map"/);
    expect(page).toMatch(/<a[^>]+class="icon-btn end"[^>]+href="\/\?lang=en"/);
    // Only an external module script, never inline code (CSP).
    expect(html()).toMatch(/<script type="module" src="\/app\/client\/app.js"><\/script>/);
    expect(html()).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
  });

  test("REQ-WEB-005 the client and the server render the same words in every language", () => {
    for (const lang of ["en", "uk", "ru"] as const) {
      const m = model(["kyiv-oblast", "chernihiv", "zhytomyr"], "kyiv-city", T0, lang);
      const page = renderPage(m);
      for (const text of [m.title, m.regionName, m.meta, m.nearby!, m.mapCaption!]) {
        expect(page).toContain(text);
      }
      expect(page).toContain(`<html lang="${lang}"`);
    }
  });

  test("REQ-WEB-010 sizes follow the browser's text size and every control shows focus", () => {
    expect(STYLESHEET).not.toMatch(/font(-size)?:[^;}]*\d+px/);
    expect(STYLESHEET).toContain("@supports (font:-apple-system-body)");
    expect(STYLESHEET).toContain(":focus-visible");
    expect(STYLESHEET).toContain("prefers-reduced-motion:reduce");
    // Clockwise, as iOS rotationEffect(turn * 360) turns, with the afterglow trailing the beam.
    expect(STYLESHEET).toContain("@keyframes sweep{to{transform:rotate(360deg)}}");
    expect(STYLESHEET).toContain(
      "conic-gradient(from 0deg,transparent 0 310deg,var(--accent-sweep) 360deg)",
    );
    const page = html(["kyiv-city"]);
    expect(page.match(/aria-live/g)).toHaveLength(1);
    expect(page).toMatch(/<h1[^>]*aria-live="polite"/);
  });

  test("REQ-WEB-014 one centred column with a maximum width and no fixed width over 320 px", () => {
    expect(STYLESHEET).toMatch(/\.shell\{max-width:34rem;margin:0 auto/);
    for (const [, n] of STYLESHEET.matchAll(/(?:^|[;{])width:(\d+)px/g)) {
      expect(Number(n)).toBeLessThanOrEqual(320);
    }
    expect(html()).toContain('name="viewport" content="width=device-width, initial-scale=1"');
  });

  test("REQ-WEB-014 every text colour reaches AA on its background, cards included", () => {
    const texts = [PALETTE.text, PALETTE.textSecondary, PALETTE.clear, PALETTE.alert];
    for (const bg of [PALETTE.background, SURFACE, over(PALETTE.alert, 0.08)]) {
      for (const colour of [...texts, PALETTE.caution, PALETTE.stale, PALETTE.checking]) {
        expect(contrastRatio(colour, bg)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});

describe("Regions page", () => {
  const snapshot = snapshotWith(["lviv", "odesa", "sumy"].map(key));

  test("REQ-WEB-013 the current region's card, then regions under alert, then the rest", () => {
    const m = regionsModel(snapshot, region("lviv"), "en");
    expect(m.current).toEqual({ name: "Lviv Oblast", accent: "alert", pill: "Alert" });
    expect(m.alerting.map((r) => r.id)).toEqual(["lviv", "odesa", "sumy"]);
    expect(m.others).toHaveLength(22);
    const page = renderRegions(m);
    expect(page).toContain("Alert Active · 3");
    expect(page.indexOf("Alert Active · 3")).toBeLessThan(page.indexOf("Other regions"));
    expect(page).toContain('<h1 class="page-title">Regions</h1>');
    expect(page).toMatch(/<a[^>]+href="\/\?lang=en"[^>]*>/);
  });

  test("REQ-WEB-013 without alerts there is no alert group", () => {
    const page = renderRegions(regionsModel(snapshotWith([]), region("kyiv-city"), "uk"));
    expect(page).not.toContain(STRINGS.uk.alertSection(0));
    expect(page).toContain("Інші регіони");
    expect(page).toContain(">Тривоги немає<");
  });

  test("REQ-WEB-004 REQ-WEB-013 every row picks its region through POST /region", () => {
    const page = renderRegions(regionsModel(snapshot, region("lviv"), "en"));
    expect(page).toMatch(/<form method="post" action="\/region"/);
    expect(page).toContain('<input type="hidden" name="lang" value="en">');
    expect(page.match(/<button[^>]+name="region" value="[a-z-]+"/g)).toHaveLength(25);
    expect(page).toContain('value="lviv" aria-current="true"');
  });
});

describe("review repairs", () => {
  test("REQ-WEB-004 a ?region= link survives Refresh, the language links and the map", () => {
    const m = statusModel(snapshotWith([]), region("kharkiv"), "en", T0, null, "kharkiv");
    const page = renderPage(m);
    expect(page).toContain('id="refresh"');
    expect(page).toMatch(/class="icon-btn end" href="\/\?region=kharkiv&amp;lang=en"/);
    expect(page).toContain('href="/?region=kharkiv&amp;lang=uk"');
    expect(page).toContain('href="/regions?region=kharkiv&amp;lang=en"');
    const regions = renderRegions(
      regionsModel(snapshotWith([]), region("kharkiv"), "en", "kharkiv"),
    );
    expect(regions).toMatch(/class="icon-btn start" href="\/\?region=kharkiv&amp;lang=en"/);
    expect(regions).toContain('href="/regions?region=kharkiv&amp;lang=ru"');
    // Without a link region, links carry only the language.
    expect(renderPage(model([]))).toContain('href="/?lang=uk"');
  });

  test("REQ-WEB-012 without scripts, a missing map says it could not load", () => {
    const none = statusModel(snapshotWith([]), region("kyiv-city"), "en", T0, null);
    expect(renderPage(none)).toMatch(/class="card map no-image"/);
    expect(renderPage(none)).toContain("Couldn&#39;t load the map.");
    expect(renderPage(model([]))).toContain('class="card map" id="map"');
    expect(STYLESHEET).toContain(".map.no-image .failed,.map.is-failed .failed{display:flex}");
  });

  test("REQ-WEB-011 REQ-SURF-010 the accents are the iOS colours", () => {
    expect(ACCENT).toEqual({
      clear: "#7CC39B",
      alert: "#F07C7C",
      caution: "#E8BA62",
      stale: "#C6CAD0",
      unavailable: "#9AA0A8",
    });
    expect(STYLESHEET).toContain(".accent-caution{--accent:#E8BA62");
    expect(STYLESHEET).toContain(".accent-alert{--accent:#F07C7C");
  });
});

describe("offline page", () => {
  test("REQ-WEB-008 the offline page is the Unavailable status in the iOS design, in one language", () => {
    for (const lang of ["en", "uk", "ru"] as const) {
      const page = renderOffline(lang);
      expect(page).toContain(`<html lang="${lang}"`);
      expect(page).toMatch(new RegExp(`<h1[^>]*>${STRINGS[lang].phase.unavailable}</h1>`));
      expect(page).toContain(STRINGS[lang].offlineNote);
      expect(page).toContain('data-glyph="question"');
      expect(page).toMatch(/<body class="accent-unavailable"/);
      expect(page).not.toContain("/v1/map");
    }
    expect(renderOffline("en")).toContain("No connection, and no saved status yet.");
  });
});

describe("review repairs, M3", () => {
  test("REQ-WEB-010 Regions rows draw their focus ring inside the rounded group, which clips", () => {
    expect(STYLESHEET).toContain(".group{margin:0;padding:0;list-style:none;overflow:hidden}");
    expect(STYLESHEET).toContain(".row:focus-visible{outline-offset:-3px");
  });

  test("REQ-WEB-014 nothing hides horizontal overflow, so a too-wide layout shows", () => {
    expect(STYLESHEET).not.toContain("overflow-x:hidden");
    // Only the decorative glow is clipped, at the hero; the radar never outgrows the column.
    expect(STYLESHEET).toMatch(/\.hero\{[^}]*overflow-x:clip\}/);
    expect(STYLESHEET).toContain(".current{display:flex;flex-wrap:wrap");
    expect(STYLESHEET).toContain(".radar{position:relative;width:min(9.75rem,100%);aspect-ratio:1");
  });
});

describe("Regions shows its age", () => {
  test("REQ-REFRESH-006 REQ-WEB-013 Regions states its update time, and Last known once stale", () => {
    const snapshot = snapshotWith(["lviv"].map(key)); // checked at T0, 12:00 Kyiv
    const fresh = regionsModel(snapshot, region("kyiv-city"), "en", null, T0);
    expect(fresh.meta).toBe("Updated 12:00");
    expect(fresh.current.accent).toBe("clear");
    const old = regionsModel(snapshot, region("kyiv-city"), "uk", null, T0 + 3 * 3_600_000);
    expect(old.meta).toBe("Востаннє відоме · Оновлено 12:00");
    expect(old.current.accent).toBe("stale");
    const page = renderRegions(old);
    expect(page).toContain("Востаннє відоме · Оновлено 12:00");
    expect(regionsModel(null, region("kyiv-city"), "en", null, T0).meta).toBeNull();
  });
});

describe("an open Regions page turns stale on time", () => {
  test("REQ-REFRESH-006 REQ-WEB-013 the client re-marks Regions at the instant its answer turns stale", () => {
    const snapshot = snapshotWith(["lviv"].map(key)); // checked at T0
    const at = staleAt(snapshot);
    expect(at).toBe(T0 + 120_001);
    const before = regionsModel(snapshot, region("kyiv-city"), "en", null, at! - 1);
    const after = regionsModel(snapshot, region("kyiv-city"), "en", null, at!);
    expect(before.meta).toBe("Updated 12:00");
    expect(after.meta).toBe("Last known · Updated 12:00");
    expect(after.current.accent).toBe("stale");
    expect(staleAt(null)).toBeNull();
  });
});
