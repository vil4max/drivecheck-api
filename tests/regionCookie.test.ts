import { describe, expect, test } from "vitest";
import { parseRegionCookie, regionCookie } from "../src/regionCookie";

describe("region cookie", () => {
  test("REQ-WEB-004 reads only a catalog id from the region cookie", () => {
    expect(parseRegionCookie("a=1; region=lviv; b=2")?.id).toBe("lviv");
    expect(parseRegionCookie("region=kyiv-city")?.id).toBe("kyiv-city");
    expect(parseRegionCookie("myregion=lviv")).toBeUndefined();
    expect(parseRegionCookie("region=atlantis")).toBeUndefined();
    expect(parseRegionCookie(null)).toBeUndefined();
  });

  test("REQ-WEB-004 writes the cookie with the spec's attributes", () => {
    expect(regionCookie("odesa")).toBe(
      "region=odesa; Path=/; Max-Age=31536000; SameSite=Lax; Secure",
    );
  });
});
