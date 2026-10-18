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

  test("REQ-WEB-002 maps ISO 3166-2:UA codes to regions", () => {
    expect(regionByIsoCode("30")?.id).toBe("kyiv-city");
    expect(regionByIsoCode("32")?.id).toBe("kyiv-oblast");
    expect(regionByIsoCode("46")?.id).toBe("lviv");
    expect(regionByIsoCode("40")).toBeUndefined();
  });
});
