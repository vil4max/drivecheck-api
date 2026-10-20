// Lists the compiled app modules in public/app/assets.json, so the service worker of a version
// precaches its whole client on install (spec 002, REQ-WEB-008). Runs after `tsc` in `npm run build`.
import { readdirSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const root = "public/app";

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

// The worker script itself is fetched by the browser, never from the cache.
const assets = walk(root)
  .filter((path) => path.endsWith(".js") && !path.endsWith(`${sep}sw.js`))
  .map((path) => `/app/${relative(root, path).split(sep).join("/")}`)
  .sort();
writeFileSync(join(root, "assets.json"), `${JSON.stringify(assets, null, 2)}\n`);
