import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const SRC = fileURLToPath(new URL("../src", import.meta.url));
const IMPORT = /(?:import|export)\s[^;]*?from\s+"(\.{1,2}\/[^"]+)"/g;
// Any absolute http(s) origin, e.g. the provider or a CDN; same-origin paths start with "/".
const ORIGIN = /https?:\/\/[a-z0-9.-]+/gi;

/** Every source file the browser would load, starting from an entry, by relative imports. */
function graph(entry: string): string[] {
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const match of readFileSync(file, "utf8").matchAll(IMPORT)) {
      visit(resolve(dirname(file), match[1]!));
    }
  };
  visit(resolve(SRC, entry));
  return [...seen];
}

function origins(files: string[]): string[] {
  // The SVG namespace in a data: URI names XML, it is never fetched.
  return files
    .flatMap((file) => readFileSync(file, "utf8").match(ORIGIN) ?? [])
    .filter((origin) => origin !== "http://www.w3.org");
}

describe("client import graph", () => {
  test("REQ-WEB-006 the browser client and service worker carry no external origin", () => {
    const files = [...graph("client/app.ts"), ...graph("sw.ts")];
    expect(origins(files)).toEqual([]);
  });

  test("REQ-WEB-006 the graph check finds the provider where it lives", () => {
    // Guards the check itself: the coordinator is the one module allowed to name Ubilling.
    expect(origins(graph("coordinator.ts"))).toContain("https://ubilling.net.ua");
  });
});
