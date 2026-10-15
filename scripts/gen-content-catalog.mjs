// Step 1 of regenerating the dashboard storefront-text catalog.
// Dumps the theme01 content sections/keys + AR/EN defaults to stdout:
//
//   node scripts/gen-content-catalog.mjs > /tmp/catalog-dump.json.txt
//   python3 scripts/gen-content-catalog.ts   # rewrites content-catalog.ts
//
// The dump must keep the "=== SECTIONS (keys) ===" / "=== AR DEFAULTS ===" /
// "=== EN DEFAULTS ===" markers (gen-content-catalog.ts parses them).

import { build } from "esbuild";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(ROOT, "scripts/.content-catalog.entry.ts");
const out = path.join(ROOT, "scripts/.content-catalog.tmp.cjs");

try {
  writeFileSync(
    entry,
    `import { ar } from "../cod-astro/theme01/src/theme/content/ar";\n` +
      `import { en } from "../cod-astro/theme01/src/theme/content/en";\n` +
      `export const packs = { ar, en };\n`,
  );
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: out,
    logLevel: "silent",
  });
  const { packs } = await import(out);
  const arSrc = readFileSync(
    path.join(ROOT, "cod-astro/theme01/src/theme/content/ar.ts"),
    "utf8",
  );

  const sections = [];
  let current = null;
  for (const line of arSrc.split("\n")) {
    const m = line.match(/^  \/\/ ── (.+?) ─+$/);
    if (m) {
      current = { title: m[1].trim(), keys: [] };
      sections.push(current);
      continue;
    }
    const k = line.match(/^  ([A-Za-z0-9_]+):/);
    if (k && current) current.keys.push(k[1]);
  }

  const arKeys = Object.keys(packs.ar);
  const enKeys = Object.keys(packs.en);
  if (JSON.stringify(arKeys) !== JSON.stringify(enKeys))
    throw new Error("ar/en key sets differ");
  const sectionKeys = sections.flatMap((s) => s.keys);
  if (sectionKeys.length !== arKeys.length || sectionKeys.some((k, i) => k !== arKeys[i]))
    throw new Error("section parsing does not cover all keys in order");

  const dump = (o) => JSON.stringify(o, null, 2);
  const arDefaults = Object.fromEntries(arKeys.map((k) => [k, packs.ar[k]]));
  const enDefaults = Object.fromEntries(enKeys.map((k) => [k, packs.en[k]]));

  console.log("=== SECTIONS (keys) ===");
  console.log(dump(sections.map((s) => ({ title: s.title, count: s.keys.length, keys: s.keys }))));
  console.log("=== AR DEFAULTS ===");
  console.log(dump(arDefaults));
  console.log("=== EN DEFAULTS ===");
  console.log(dump(enDefaults));
} finally {
  rmSync(entry, { force: true });
  rmSync(out, { force: true });
}
