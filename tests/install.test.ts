import { describe, expect, test } from "vitest";
import { installAffordance } from "../src/client/install";

const UA = {
  iphoneSafari:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1",
  iphoneChrome:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.0.0 Mobile/15E148 Safari/604.1",
  macSafari:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
  macChrome:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  windowsEdge:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0",
};

describe("install affordance", () => {
  test("REQ-WEB-009 a button where the browser offers installation", () => {
    for (const userAgent of [UA.macChrome, UA.windowsEdge]) {
      expect(installAffordance({ standalone: false, promptAvailable: true, userAgent })).toBe(
        "button",
      );
    }
  });

  test("REQ-WEB-009 nothing once installed, even if a prompt is offered", () => {
    expect(
      installAffordance({ standalone: true, promptAvailable: true, userAgent: UA.macChrome }),
    ).toBe("none");
    expect(
      installAffordance({ standalone: true, promptAvailable: false, userAgent: UA.iphoneSafari }),
    ).toBe("none");
  });

  test("REQ-WEB-009 a menu hint in Safari, which has no install event", () => {
    const at = (userAgent: string) =>
      installAffordance({ standalone: false, promptAvailable: false, userAgent });
    expect(at(UA.iphoneSafari)).toBe("safari-ios");
    expect(at(UA.macSafari)).toBe("safari-mac");
    expect(at(UA.iphoneChrome)).toBe("none");
    expect(at(UA.macChrome)).toBe("none");
    expect(at(UA.windowsEdge)).toBe("none");
  });
});
