import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { renderPage } from "../src/page";
import { regionById } from "../src/regions";
import { statusModel } from "../src/view";
import { snapshotWith, T0 } from "./support";

const PUBLIC = fileURLToPath(new URL("../public/", import.meta.url));

/** Width and height from a PNG's IHDR chunk. */
function pngSize(path: string): [number, number] {
  const bytes = readFileSync(path);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect([...bytes.slice(1, 4)]).toEqual([0x50, 0x4e, 0x47]); // "PNG"
  return [view.getUint32(16), view.getUint32(20)];
}

describe("web app manifest", () => {
  const manifest = JSON.parse(readFileSync(`${PUBLIC}manifest.webmanifest`, "utf8")) as {
    id: string;
    start_url: string;
    scope: string;
    display: string;
    name: string;
    short_name: string;
    background_color: string;
    theme_color: string;
    icons: { src: string; sizes: string; type: string }[];
  };

  test("REQ-WEB-007 declares a standalone app at / in the iOS colours", () => {
    expect(manifest).toMatchObject({
      id: "/",
      start_url: "/",
      scope: "/",
      display: "standalone",
      name: "Drive Check",
      short_name: "Drive Check",
      background_color: "#0C0E11",
      theme_color: "#0C0E11",
    });
  });

  test("REQ-WEB-007 its PNG icons exist at 192 and 512 px, and the touch icon at 180 px", () => {
    const sizes = manifest.icons.map((icon) => {
      expect(icon.type).toBe("image/png");
      const file = `${PUBLIC}${icon.src.replace(/^\//, "")}`;
      expect(existsSync(file)).toBe(true);
      const [w, h] = pngSize(file);
      expect(`${w}x${h}`).toBe(icon.sizes);
      return icon.sizes;
    });
    expect(sizes).toEqual(expect.arrayContaining(["192x192", "512x512"]));
    expect(pngSize(`${PUBLIC}icons/apple-touch-icon-180.png`)).toEqual([180, 180]);
  });

  test("REQ-WEB-007 the page links the manifest, the touch icon and the theme colour", () => {
    const page = renderPage(
      statusModel(snapshotWith([]), regionById("kyiv-city")!, "en", T0, null),
    );
    expect(page).toContain('<link rel="manifest" href="/manifest.webmanifest">');
    expect(page).toContain('<link rel="apple-touch-icon" href="/icons/apple-touch-icon-180.png">');
    expect(page).toContain('<meta name="theme-color" content="#0C0E11">');
  });

  test("REQ-WEB-008 the service worker may control the whole site and is never cached stale", () => {
    const headers = readFileSync(`${PUBLIC}_headers`, "utf8");
    expect(headers).toMatch(/\/app\/sw\.js\n(\s+.+\n)*\s+Service-Worker-Allowed: \/\n/);
    expect(headers).toMatch(/\/app\/sw\.js\n(\s+.+\n)*\s+Cache-Control: no-cache/);
  });
});
