import { describe, expect, test } from "vitest";
import { neighbours, REGIONS, regionById, regionByIsoCode } from "../src/regions";
import { statusView } from "../src/status";
import { snapshotWith, T0 } from "./support";

const kyiv = regionById("kyiv-city")!;

describe("status view", () => {
  test("REQ-REGION-001 has the 25 app regions and ignores unknown feed keys", () => {
    expect(REGIONS).toHaveLength(25);
    const view = statusView(snapshotWith(["Севастополь"]), kyiv, T0);
    expect(view.phase).toBe("quiet");
    expect(view.nearby).toEqual([]);
  });

  test("REQ-REGION-001 a region missing from the feed is Region Unavailable, not Unavailable", () => {
    expect(statusView(snapshotWith([], ["м. Київ"]), kyiv, T0).phase).toBe("regionUnavailable");
    expect(statusView(null, kyiv, T0).phase).toBe("unavailable");
  });

  test("REQ-SURF-005 lists neighbours under alert whether the region is quiet or in alarm", () => {
    const quiet = statusView(
      snapshotWith(["Київська область", "Чернігівська область", "Львівська область"]),
      kyiv,
      T0,
    );
    expect(quiet.phase).toBe("quiet");
    expect(quiet.nearby.map((r) => r.id)).toEqual(["kyiv-oblast", "chernihiv"]);
    const alarm = statusView(snapshotWith(["м. Київ", "Київська область"]), kyiv, T0);
    expect(alarm.phase).toBe("alarm");
    expect(alarm.nearby.map((r) => r.id)).toEqual(["kyiv-oblast"]);
  });

  test("REQ-SURF-005 uses the iOS neighbour table, with Kyiv city's wider ring", () => {
    expect(neighbours(kyiv).map((r) => r.id)).toEqual([
      "kyiv-oblast",
      "chernihiv",
      "zhytomyr",
      "cherkasy",
      "poltava",
    ]);
    expect(neighbours(regionById("volyn")!).map((r) => r.id)).toEqual(["rivne", "lviv"]);
  });

  test("REQ-REFRESH-006 is stale only after 2 minutes from checkedAt and keeps the phase", () => {
    const snapshot = snapshotWith(["м. Київ"]);
    expect(statusView(snapshot, kyiv, T0 + 120_000).stale).toBe(false);
    const old = statusView(snapshot, kyiv, T0 + 120_001);
    expect(old.stale).toBe(true);
    expect(old.phase).toBe("alarm");
  });

  describe("REQ-SURF-010 surrounded", () => {
    const keyOf = (id: string) => regionById(id)!.apiKey;
    const surrounded = (id: string, alarmIds: string[], now = T0) =>
      statusView(snapshotWith(alarmIds.map(keyOf)), regionById(id)!, now).surrounded;
    // Regions with no neighbour of Dnipropetrovsk, to fill the country without touching its ring.
    const far = ["volyn", "lviv", "rivne", "ternopil", "zakarpattia", "ivano-frankivsk"];
    const farther = ["chernivtsi", "khmelnytskyi", "zhytomyr", "chernihiv", "sumy", "kyiv-city"];

    test("REQ-SURF-010 Kyiv city is surrounded by Kyiv Oblast alone, one way only", () => {
      expect(surrounded("kyiv-city", ["kyiv-oblast"])).toBe(true);
      expect(surrounded("kyiv-oblast", ["kyiv-city"])).toBe(false);
    });

    test("REQ-SURF-010 half or more of the neighbours under alert", () => {
      expect(surrounded("volyn", ["rivne"])).toBe(true);
      expect(surrounded("dnipropetrovsk", ["poltava", "kharkiv", "donetsk"])).toBe(false);
      expect(surrounded("dnipropetrovsk", ["poltava", "kharkiv", "donetsk", "kherson"])).toBe(true);
    });

    test("REQ-SURF-010 more than half of the country, with at least one neighbour", () => {
      const twelve = [...far, ...farther];
      expect(surrounded("dnipropetrovsk", ["poltava", ...twelve])).toBe(true);
      expect(surrounded("dnipropetrovsk", ["poltava", ...twelve.slice(1)])).toBe(false);
      expect(surrounded("dnipropetrovsk", [...twelve, "odesa"])).toBe(false);
    });

    test("REQ-SURF-010 never for stale data or a region in alarm itself", () => {
      expect(surrounded("volyn", ["rivne"], T0 + 120_001)).toBe(false);
      expect(surrounded("volyn", ["volyn", "rivne"])).toBe(false);
      expect(statusView(null, regionById("volyn")!, T0).surrounded).toBe(false);
    });
  });

  test("REQ-WEB-002 maps ISO 3166-2:UA codes to regions", () => {
    expect(regionByIsoCode("30")?.id).toBe("kyiv-city");
    expect(regionByIsoCode("32")?.id).toBe("kyiv-oblast");
    expect(regionByIsoCode("46")?.id).toBe("lviv");
    expect(regionByIsoCode("40")).toBeUndefined();
  });
});
