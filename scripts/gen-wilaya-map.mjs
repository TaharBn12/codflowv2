// Generates cod-client-astro/src/features/dashboard/wilaya-map.ts from real
// Algeria 58-wilaya boundaries, so the dashboard heatmap renders a true map.
//
// Usage:
//   node scripts/gen-wilaya-map.mjs --file /path/to/v58/algeria-cities.geojson
//   node scripts/gen-wilaya-map.mjs            # downloads the file first
//
// Source: https://github.com/namrouche993/algeria-wilayas-geojson (v58, MIT).
// The 3.8MB source GeoJSON is NOT committed — only the generated paths are.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_URL =
  "https://raw.githubusercontent.com/namrouche993/algeria-wilayas-geojson/main/v58/algeria-cities.geojson";
const SOURCE_REPO = "namrouche993/algeria-wilayas-geojson (v58/algeria-cities.geojson, MIT)";
const OUT = path.join(ROOT, "cod-client-astro/src/features/dashboard/wilaya-map.ts");

const args = process.argv.slice(2);
const fileArg = args.includes("--file") ? args[args.indexOf("--file") + 1] : null;

let fc;
if (fileArg) {
  fc = JSON.parse(readFileSync(fileArg, "utf8"));
} else {
  console.log("downloading", SOURCE_URL);
  const res = await fetch(SOURCE_URL);
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  fc = await res.json();
}
if (!Array.isArray(fc.features) || fc.features.length !== 58) {
  throw new Error(`expected 58 features, got ${fc.features?.length}`);
}

// ── Platform wilaya names (1-58), parsed from the theme01 reference list ────
const wilayasSrc = readFileSync(
  path.join(ROOT, "cod-astro/theme01/src/core/data/wilayas.ts"),
  "utf8",
);
const platformWilayas = [];
for (const m of wilayasSrc.matchAll(
  /\{\s*id:\s*(\d+),\s*name:\s*"([^"]+)",\s*nameAr:\s*"([^"]+)"\s*\}/g,
)) {
  platformWilayas.push({ id: Number(m[1]), name: m[2], nameAr: m[3] });
}
if (platformWilayas.length !== 58) throw new Error(`expected 58 platform wilayas, got ${platformWilayas.length}`);

function normalize(name) {
  return name
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Z0-9]/g, "");
}

// ── Match GADM features to platform wilaya ids by normalized name ───────────
// GADM short-name variants that do not normalize onto the platform names.
const GADM_ALIASES = {
  MENIAA: "ELMENIAA", // "El Meniaa"
  MEGHAIER: "ELMGHAIR", // "El M'Ghair" (aka Meghguer / Mekhalfa)
};

const byPlatformName = new Map(platformWilayas.map((w) => [normalize(w.name), w]));
const mapping = new Map(); // platformId -> feature
const collisions = [];
for (const feat of fc.features) {
  const gadmName = String(feat.properties.nam ?? "").trim();
  const normalized = GADM_ALIASES[normalize(gadmName)] ?? normalize(gadmName);
  const platform = byPlatformName.get(normalized);
  if (!platform) throw new Error(`no platform wilaya matches GADM name "${gadmName}"`);
  if (mapping.has(platform.id)) collisions.push(platform.id);
  mapping.set(platform.id, { feature: feat, gadmName });
}
const missing = platformWilayas.filter((w) => !mapping.has(w.id)).map((w) => `${w.id} ${w.name}`);
if (missing.length || collisions.length) {
  throw new Error(`mapping broken — missing: ${missing.join(", ") || "none"}; duplicate ids: ${collisions.join(", ") || "none"}`);
}
console.log("matched all 58 wilayas by name:");
for (const w of platformWilayas) console.log(`  ${w.id} ${w.name} <- "${mapping.get(w.id).gadmName}"`);

// ── Projection: equirectangular with central-meridian cos correction ────────
function flattenRings(geometry) {
  if (geometry.type === "Polygon") return [geometry.coordinates];
  if (geometry.type === "MultiPolygon") return geometry.coordinates;
  throw new Error(`unsupported geometry ${geometry.type}`);
}

const allPts = [];
for (const { feature } of mapping.values())
  for (const poly of flattenRings(feature.geometry))
    for (const ring of poly) for (const [lon, lat] of ring) allPts.push([lon, lat]);
const minLon = Math.min(...allPts.map((p) => p[0]));
const maxLon = Math.max(...allPts.map((p) => p[0]));
const minLat = Math.min(...allPts.map((p) => p[1]));
const maxLat = Math.max(...allPts.map((p) => p[1]));
const midLat = ((minLat + maxLat) / 2) * (Math.PI / 180);
const KX = Math.cos(midLat);

const WIDTH = 1000;
const LAT_SPAN = maxLat - minLat;
const LON_SPAN = (maxLon - minLon) * KX;
const SCALE = WIDTH / Math.max(LON_SPAN, LAT_SPAN);
const HEIGHT = Math.round(Math.max(LON_SPAN, LAT_SPAN) * SCALE);

function project([lon, lat]) {
  return [
    (lon - minLon) * KX * SCALE,
    (maxLat - lat) * SCALE,
  ];
}

// ── Douglas-Peucker simplification (pixel space) ─────────────────────────────
function distToSegment(p, a, b) {
  const [px, py] = p, [ax, ay] = a, [bx, by] = b;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

function douglasPeucker(points, tolerance) {
  if (points.length < 3) return points;
  const [first, last] = [points[0], points[points.length - 1]];
  let maxDist = 0, maxIdx = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const d = distToSegment(points[i], first, last);
    if (d > maxDist) { maxDist = d; maxIdx = i; }
  }
  if (maxDist > tolerance) {
    const left = douglasPeucker(points.slice(0, maxIdx + 1), tolerance);
    const right = douglasPeucker(points.slice(maxIdx), tolerance);
    return left.slice(0, -1).concat(right);
  }
  return [first, last];
}

const TOLERANCE_PX = 1.1; // ~2.3km at 1000px width

const r1 = (n) => Math.round(n * 100) / 100;

function ringToPath(projected) {
  if (projected.length < 3) return "";
  const simplified = douglasPeucker(projected, TOLERANCE_PX);
  let d = `M${r1(simplified[0][0])} ${r1(simplified[0][1])}`;
  for (let i = 1; i < simplified.length; i++) d += `L${r1(simplified[i][0])} ${r1(simplified[i][1])}`;
  return d + "Z";
}

// ── Build one SVG path per wilaya (all its polygons/rings) ───────────────────
const paths = {};
let totalPoints = 0;
for (const w of platformWilayas) {
  const { feature } = mapping.get(w.id);
  const parts = [];
  for (const poly of flattenRings(feature.geometry)) {
    for (const ring of poly) {
      const projected = ring.map(project);
      totalPoints += projected.length;
      const d = ringToPath(projected);
      if (d) parts.push(d);
    }
  }
  if (!parts.length) throw new Error(`wilaya ${w.id} produced an empty path`);
  paths[w.id] = parts.join("");
}

// ── Write the generated module ───────────────────────────────────────────────
mkdirSync(path.dirname(OUT), { recursive: true });
const lines = [];
lines.push(`/**`);
lines.push(` * GENERATED FILE — do not edit by hand.`);
lines.push(` *`);
lines.push(` * Real 58-wilaya boundaries of Algeria for the dashboard heatmap.`);
lines.push(` * Source: ${SOURCE_REPO} — ${SOURCE_URL}`);
lines.push(` * Generated: ${new Date().toISOString().slice(0, 10)} by scripts/gen-wilaya-map.mjs`);
lines.push(` * (equirectangular projection, Douglas-Peucker simplification, ${WIDTH}px wide canvas).`);
lines.push(` */`);
lines.push(`export const WILAYA_MAP_VIEWBOX = \`0 0 ${WIDTH} ${HEIGHT}\`;`);
lines.push(``);
lines.push(`/** SVG path data per platform wilaya id (1-58). */`);
lines.push(`export const WILAYA_MAP_PATHS: Record<number, string> = {`);
for (const w of platformWilayas) {
  lines.push(`  ${w.id}: ${JSON.stringify(paths[w.id])},`);
}
lines.push(`};`);
lines.push(``);

writeFileSync(OUT, lines.join("\n"));
const outSize = readFileSync(OUT).length;
console.log(`\nwrote ${OUT}`);
console.log(`  viewBox: 0 0 ${WIDTH} ${HEIGHT}`);
console.log(`  input ring points: ${totalPoints}`);
console.log(`  output size: ${(outSize / 1024).toFixed(1)} KB`);
