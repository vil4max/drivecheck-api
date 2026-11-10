import { describe, expect, test } from "vitest";
import type { Snapshot } from "../src/feed";
import { LANGS } from "../src/i18n";
import { endPayload, startPayload, updatePayload } from "../src/push/liveActivity";
import { alertStartPayload, alertStartTitle, sourceLabel } from "../src/push/text";
import { REGIONS } from "../src/regions";
import { snapshotWith } from "./support";

/** 2026-11-10 00:00:00 UTC: 1,794,268,800 s since 1970 and 815,961,600 s since 2001. */
const NOV10 = Date.UTC(2026, 10, 10);

const at = (checked: number, source = "fixture"): Snapshot => {
  const base = snapshotWith([]);
  return { ...base, feed: { ...base.feed, source }, fetchedAt: checked, serverCachedAt: checked };
};

const CONTENT_KEYS = ["checkedAt", "isStale", "phase", "regionTitle", "sourceLabel"];

describe("Live Activity payloads", () => {
  test("REQ-PUSHAPI-010 the payloads decode as the app's content state", () => {
    const now = NOV10 + 2_500;
    const start = JSON.parse(startPayload("kharkiv", "uk", at(NOV10), now));
    expect(start).toEqual({
      aps: {
        event: "start",
        timestamp: 1_794_268_802,
        "attributes-type": "DriveCheckActivityAttributes",
        attributes: {},
        "input-push-token": 1,
        "stale-date": 1_794_268_800 + 900,
        "interruption-level": "active",
        alert: { title: "Повітряна тривога: Харківська область", sound: "drivecheck.caf" },
        "content-state": {
          phase: "alarm",
          regionTitle: "Харківська область",
          checkedAt: 815_961_600,
          sourceLabel: "Зовнішнє джерело",
          isStale: false,
        },
      },
    });

    const update = JSON.parse(updatePayload("kyiv-city", "en", at(NOV10 + 300_000), now));
    expect(Object.keys(update.aps).sort()).toEqual([
      "content-state",
      "event",
      "stale-date",
      "timestamp",
    ]);
    expect(update.aps.event).toBe("update");
    expect(update.aps["stale-date"]).toBe(1_794_268_800 + 300 + 900);
    expect(update.aps["content-state"]).toEqual({
      phase: "alarm",
      regionTitle: "Kyiv",
      checkedAt: 815_961_600 + 300,
      sourceLabel: "External feed",
      isStale: false,
    });

    // The all-clear in one step: the green final content and a 5-minute dismissal, no alert.
    const end = JSON.parse(endPayload("odesa", "ru", at(NOV10, "Mørk Skogen"), now));
    expect(Object.keys(end.aps).sort()).toEqual([
      "content-state",
      "dismissal-date",
      "event",
      "timestamp",
    ]);
    expect(end.aps.event).toBe("end");
    expect(end.aps["dismissal-date"]).toBe(1_794_268_802 + 300);
    expect(end.aps["content-state"]).toEqual({
      phase: "quiet",
      regionTitle: "Одесская область",
      checkedAt: 815_961_600,
      sourceLabel: "Лента тревог",
      isStale: false,
    });

    // Every region and language: the app's five keys, the region's own name, at most 4 KB.
    for (const region of REGIONS) {
      for (const lang of LANGS) {
        for (const build of [startPayload, updatePayload, endPayload]) {
          const payload = build(region.id, lang, at(NOV10), now);
          expect(new TextEncoder().encode(payload).length).toBeLessThanOrEqual(4096);
          const state = JSON.parse(payload).aps["content-state"];
          expect(Object.keys(state).sort()).toEqual(CONTENT_KEYS);
          expect(state.regionTitle).toBe(region.names[lang]);
        }
      }
    }
  });

  test("REQ-PUSHAPI-010 the source label follows the app's rule", () => {
    expect(sourceLabel("Mørk Skogen", "en")).toBe("Alert feed");
    expect(sourceLabel("SKOGEN feed", "uk")).toBe("Стрічка тривог");
    expect(sourceLabel("mork", "ru")).toBe("Лента тревог");
    expect(sourceLabel("fixture", "en")).toBe("External feed");
    expect(sourceLabel("", "ru")).toBe("Внешний источник");
  });
});

describe("the alert-start notice", () => {
  test("REQ-PUSHAPI-012 the alert-start text in three languages", () => {
    expect(alertStartTitle("kharkiv", "uk")).toBe("Повітряна тривога: Харківська область");
    expect(alertStartTitle("kyiv-city", "en")).toBe("Air raid alert: Kyiv");
    expect(alertStartTitle("odesa", "ru")).toBe("Воздушная тревога: Одесская область");
    expect(JSON.parse(alertStartPayload("lviv", "en"))).toEqual({
      aps: {
        alert: { title: "Air raid alert: Lviv Oblast" },
        sound: "drivecheck.caf",
        "interruption-level": "active",
      },
    });
    for (const region of REGIONS) {
      for (const lang of LANGS) {
        const payload = alertStartPayload(region.id, lang);
        expect(new TextEncoder().encode(payload).length).toBeLessThanOrEqual(4096);
        expect(JSON.parse(payload).aps.alert.title).toContain(region.names[lang]);
      }
    }
  });
});
