#!/usr/bin/env node
/**
 * CodFlow — one-command Cloudflare deploy.
 *
 * Implements the `codflow-setup` agent runbook
 * (.agents/skills/codflow-setup/SKILL.md) end to end:
 *
 *   1. npm ci (workspace install)
 *   2. Create dedicated resources: D1, R2 bucket, 2× KV namespaces (idempotent)
 *   3. Bind real IDs into cod-server/wrangler.toml + cod-client-astro/wrangler.toml
 *      (+ unique worker names, root .env, dashboard .env, .dev.vars files)
 *   4. Generate secrets (BETTER_AUTH_SECRET, MCP_LOGIN_TICKET_SECRET, STORE_API_KEY)
 *   5. Migrate + seed remote D1, seed admin user
 *   6. Deploy server → dashboard → storefront theme, wire real URLs, redeploy,
 *      smoke-test every worker
 *   7. Print resource inventory + write credentials file (chmod 600) to $HOME
 *
 * Idempotent: safe to re-run. Existing resources (matched by name) are reused,
 * existing secrets (in .dev.vars) are reused, migrations are no-ops when
 * applied, admin seed is upsert-by-email, catalog seed is skipped when the
 * products table is non-empty (unless --force-reseed).
 *
 * Usage:
 *   # authenticate first (ONE of these):
 *   npx wrangler login
 *   # .. or non-interactive:
 *   export CLOUDFLARE_API_TOKEN='<token>' CLOUDFLARE_ACCOUNT_ID='<account-id>'
 *
 *   # then:
 *   npm run deploy:cloudflare
 *   PROJECT_PREFIX=mystore ADMIN_EMAIL=me@example.com npm run deploy:cloudflare
 *   node scripts/cloudflare-deploy.mjs --help
 *
 * Env / flags (flags win over env):
 *   PROJECT_PREFIX        resource + worker name prefix   [default: codflowv2]
 *   ADMIN_EMAIL           admin login email               [default: admin@codflow.store]
 *   ADMIN_NAME            admin display name              [default: Admin]
 *   ADMIN_PASSWORD        admin password                  [default: generated]
 *   MEDIA_DOMAIN          R2 custom media hostname        [default: media.example.com placeholder]
 *   R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY               [optional: enables image presign]
 *   COD_DB_LOCATION       D1 location hint (weur/eeur/…)  [optional]
 *   SKIP_SEED=1           skip demo catalog seed
 *   --force-reseed        re-seed catalog even if products exist
 *   --dry-run             validate config generation with fake IDs (no network, no writes to repo)
 *   --skip-deploy         create resources + configs + migrate/seed, but skip worker deploys
 *   --server-url, --dashboard-url, --store-url  override captured worker URLs (re-runs)
 */

import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_DIR = join(ROOT, "cod-server");
const DASH_DIR = join(ROOT, "cod-client-astro");
const THEME_DIR = join(ROOT, "cod-astro", "theme01");

// ── CLI args ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
function flag(name) {
  const i = argv.findIndex((a) => a === name || a.startsWith(name + "="));
  if (i === -1) return undefined;
  const a = argv[i];
  return a.includes("=") ? a.slice(name.length + 1) : "1";
}
if (flag("--help") || flag("-h")) {
  const src = readFileSync(fileURLToPath(import.meta.url), "utf8");
  const doc = src.match(/\/\*\*([\s\S]*?)\*\//)?.[1] ?? "";
  console.log(doc.replace(/^ \* ?/gm, "").trim());
  process.exit(0);
}

const CFG = {
  prefix: flag("--prefix") ?? process.env.PROJECT_PREFIX ?? "codflowv2",
  adminEmail: flag("--admin-email") ?? process.env.ADMIN_EMAIL ?? "admin@codflow.store",
  adminName: flag("--admin-name") ?? process.env.ADMIN_NAME ?? "Admin",
  adminPassword: flag("--admin-password") ?? process.env.ADMIN_PASSWORD ?? "",
  mediaDomain: flag("--media-domain") ?? process.env.MEDIA_DOMAIN ?? "",
  dbLocation: flag("--db-location") ?? process.env.COD_DB_LOCATION ?? "",
  skipSeed: flag("--skip-seed") === "1" || process.env.SKIP_SEED === "1",
  forceReseed: flag("--force-reseed") === "1",
  dryRun: flag("--dry-run") === "1",
  skipDeploy: flag("--skip-deploy") === "1",
  serverUrl: flag("--server-url") ?? "",
  dashboardUrl: flag("--dashboard-url") ?? "",
  storeUrl: flag("--store-url") ?? "",
  r2KeyId: process.env.R2_ACCESS_KEY_ID ?? "",
  r2Secret: process.env.R2_SECRET_ACCESS_KEY ?? "",
  accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? process.env.COD_ACCOUNT_ID ?? "",
};
const NAMES = {
  serverWorker: `${CFG.prefix}-server`,
  dashWorker: `${CFG.prefix}-dashboard`,
  themeWorker: `${CFG.prefix}-theme01`,
  db: `${CFG.prefix}-db`,
  bucket: `${CFG.prefix}-images`,
  kvRate: `${CFG.prefix}-rate-limit`,
  kvOAuth: `${CFG.prefix}-oauth`,
};
if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(CFG.prefix)) {
  fail(`Bad PROJECT_PREFIX '${CFG.prefix}' — use lowercase letters, digits, dashes.`);
}

// ── logging ─────────────────────────────────────────────────────────────────
const stepNo = { n: 0 };
function step(title) {
  stepNo.n += 1;
  console.log(`\n${"═".repeat(64)}\n▸ Step ${stepNo.n}: ${title}\n${"═".repeat(64)}`);
}
function info(m) { console.log(`  ${m}`); }
function ok(m) { console.log(`  ✓ ${m}`); }
function warn(m) { console.log(`  ⚠ ${m}`); }
function fail(m) { console.error(`\n  ✘ FAILED: ${m}\n`); process.exit(1); }
function sh(cmd, args, opts = {}) {
  const label = opts.label ?? `${cmd} ${args.join(" ")}`.slice(0, 120);
  if (!opts.quiet) info(`$ ${label}`);
  try {
    const out = execFileSync(cmd, args, {
      cwd: opts.cwd ?? ROOT, encoding: "utf8", stdio: opts.stdio ?? "pipe",
      input: opts.input, env: { ...process.env, ...opts.env },
      maxBuffer: 64 * 1024 * 1024,
    });
    return out ?? "";
  } catch (err) {
    if (opts.allowFail) return err.stdout?.toString() ?? "";
    const tail = (err.stderr?.toString() ?? err.message ?? "").split("\n").slice(-12).join("\n");
    fail(`${label}\n${tail}`);
  }
}

// ── wrangler helpers (tolerant parsers across wrangler 4.x outputs) ──────────
function wrangler(args, opts = {}) {
  return sh("npx", ["wrangler", ...args], opts);
}
function tryJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}
function findD1(name) {
  const out = wrangler(["d1", "list", "--json"], { label: "wrangler d1 list --json" });
  const arr = tryJson(out);
  if (Array.isArray(arr)) {
    const hit = arr.find((d) => d?.name === name);
    if (hit) return hit.uuid ?? hit.database_id ?? hit.id ?? null;
  }
  return null;
}
function createD1(name) {
  const args = ["d1", "create", name];
  if (CFG.dbLocation) args.push("--location", CFG.dbLocation);
  const out = wrangler(args, { allowFail: true, label: `wrangler d1 create ${name}` });
  const m = out.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return m?.[0] ?? null;
}
function listKv() {
  const out = wrangler(["kv", "namespace", "list"], { label: "wrangler kv namespace list" });
  const arr = tryJson(out);
  if (Array.isArray(arr)) return arr;
  return [];
}
function createKv(title) {
  const out = wrangler(["kv", "namespace", "create", title], {
    allowFail: true, label: `wrangler kv namespace create ${title}`,
  });
  const j = tryJson(out);
  if (j?.id) return j.id;
  const m = out.match(/([0-9a-f]{32})/i);
  return m?.[1] ?? null;
}
function listBuckets() {
  const out = wrangler(["r2", "bucket", "list"], { label: "wrangler r2 bucket list" });
  const arr = tryJson(out);
  if (Array.isArray(arr)) return arr.map((b) => (typeof b === "string" ? b : b.name));
  return out.split("\n").map((l) => l.trim().split(/\s+/)[0]).filter(Boolean);
}
function createBucket(name) {
  const out = wrangler(["r2", "bucket", "create", name], {
    allowFail: true, label: `wrangler r2 bucket create ${name}`,
  });
  return /success|created/i.test(out) ? true : out;
}
function ensureD1() {
  let id = findD1(NAMES.db);
  if (id) { ok(`D1 '${NAMES.db}' already exists — reusing id ${id}`); return id; }
  info(`Creating D1 '${NAMES.db}'…`);
  id = createD1(NAMES.db);
  if (!id) id = findD1(NAMES.db);
  if (!id) fail(`Could not create or find D1 '${NAMES.db}'. Check token permissions (D1 write) and retry.`);
  ok(`D1 '${NAMES.db}' id ${id}`);
  return id;
}
function ensureKv(title) {
  const existing = listKv().find((ns) => ns?.title === title);
  if (existing?.id) { ok(`KV '${title}' already exists — reusing id ${existing.id}`); return existing.id; }
  info(`Creating KV namespace '${title}'…`);
  let id = createKv(title);
  if (!id) id = listKv().find((ns) => ns?.title === title)?.id ?? null;
  if (!id) fail(`Could not create or find KV '${title}'. Check token permissions (KV write) and retry.`);
  ok(`KV '${title}' id ${id}`);
  return id;
}
function ensureBucket() {
  if (listBuckets().includes(NAMES.bucket)) {
    ok(`R2 bucket '${NAMES.bucket}' already exists — reusing it`);
    return;
  }
  info(`Creating R2 bucket '${NAMES.bucket}'…`);
  const res = createBucket(NAMES.bucket);
  if (res !== true) {
    if (/exist/i.test(String(res))) { ok(`R2 bucket '${NAMES.bucket}' already exists — reusing it`); return; }
    fail(`Could not create R2 bucket '${NAMES.bucket}'.\n${String(res).split("\n").slice(-8).join("\n")}\nIf R2 is not enabled on this account, open dash.cloudflare.com → R2 (requires a payment card on file, free tier), then re-run this script.`);
  }
  ok(`R2 bucket '${NAMES.bucket}' created`);
}

// ── config generation (pure string transforms — also exercised by --dry-run) ─
function replaceTomlVar(text, key, value) {
  const re = new RegExp(`^(${key}\\s*=\\s*).*$`, "m");
  if (!re.test(text)) fail(`Template drift: key '${key}' not found while generating config.`);
  return text.replace(re, `$1"${value}"`);
}
function replaceInlineVar(text, key, value) {
  const re = new RegExp(`(${key}\\s*=\\s*")[^"]*(")`, "g");
  if (!re.test(text)) fail(`Template drift: inline key '${key}' not found while generating config.`);
  re.lastIndex = 0;
  return text.replace(re, `$1${value}$2`);
}
function genServerToml(tpl, v) {
  let t = tpl;
  t = replaceTomlVar(t, "name", v.serverWorker);
  t = t.split('database_name = "codflow-os-db"').join(`database_name = "${v.dbName}"`);
  t = t.split("00000000-0000-0000-0000-000000000000").join(v.dbId);
  t = t.split('bucket_name = "codflow-images"').join(`bucket_name = "${v.bucket}"`);
  t = t.split('R2_BUCKET_NAME = "codflow-images"').join(`R2_BUCKET_NAME = "${v.bucket}"`);
  t = t.replace(/(binding = "RATE_LIMIT"\s*\nid = ")[0-9a-f-]*(")/g, `$1${v.kvRate}$2`);
  t = t.replace(/(binding = "OAUTH_KV"\s*\nid = ")[0-9a-f-]*(")/g, `$1${v.kvOAuth}$2`);
  t = replaceTomlVar(t, "WORKER_URL", v.serverUrl);
  t = replaceTomlVar(t, "BETTER_AUTH_URL", v.betterAuthUrl);
  t = replaceTomlVar(t, "WORKER_SELF_URL", v.serverUrl + "/");
  t = replaceTomlVar(t, "MEDIA_DOMAIN", v.mediaDomain);
  t = replaceTomlVar(t, "ALLOWED_ORIGINS", v.allowedOrigins);
  t = replaceInlineVar(t, "WORKER_URL", v.serverUrl);
  t = replaceInlineVar(t, "BETTER_AUTH_URL", v.betterAuthUrl);
  t = replaceInlineVar(t, "WORKER_SELF_URL", v.serverUrl + "/");
  t = replaceInlineVar(t, "MEDIA_DOMAIN", v.mediaDomain);
  t = replaceInlineVar(t, "ALLOWED_ORIGINS", v.allowedOrigins);
  if (v.storeUrl) {
    if (/STOREFRONT_URL/.test(t)) t = replaceInlineVar(t, "STOREFRONT_URL", v.storeUrl);
    if (/^STOREFRONT_URL\s*=/m.test(t)) t = replaceTomlVar(t, "STOREFRONT_URL", v.storeUrl);
  }
  return t;
}
function genDashToml(tpl, v) {
  let t = tpl;
  t = replaceTomlVar(t, "name", v.dashWorker);
  t = t.split('database_name = "codflow-db"').join(`database_name = "${v.dbName}"`);
  t = t.split("<your-d1-database-id>").join(v.dbId);
  t = t.split("<your-kv-namespace-id>").join(v.kvRate);
  t = replaceTomlVar(t, "PUBLIC_APP_URL", v.dashUrl);
  t = replaceTomlVar(t, "PUBLIC_API_URL", v.serverUrl);
  t = replaceTomlVar(t, "PUBLIC_TRUSTED_ORIGINS", v.trustedOrigins);
  return t;
}
function genThemeWrangler(tpl, workerName) {
  if (!tpl.includes('"codflow-os-theme01"')) fail("Template drift: theme01 worker name not found.");
  return tpl.split('"codflow-os-theme01"').join(`"${workerName}"`);
}
const HARD_PLACEHOLDER_RES = [
  /00000000-0000/, /00000000000000000000000000000000/, /<your-/,
  /"codflow-server"/, /"codflow-dashboard"/, /codflow-os-theme01/,
];
const RESOURCE_NAME_RES = [/codflow-os-db/, /"codflow-images"/];
const SOFT_PLACEHOLDER_RES = [/media\.example\.com/, /example\.com/];
function stripTomlComments(text) {
  return text.split("\n").filter((l) => !l.trimStart().startsWith("#")).join("\n");
}
function assertNoPlaceholders(label, text) {
  const hard = HARD_PLACEHOLDER_RES.filter((re) => re.test(text));
  if (hard.length) fail(`${label} still contains placeholders: ${hard.join(" ")}`);
  const code = stripTomlComments(text);
  const names = RESOURCE_NAME_RES.filter((re) => re.test(code));
  if (names.length) fail(`${label} still contains resource-name placeholders: ${names.join(" ")}`);
  const soft = SOFT_PLACEHOLDER_RES.filter((re) => re.test(code));
  if (soft.length) {
    warn(`${label}: domain placeholders remain (${soft.join(" ")}) — expected without a custom domain (runbook Step 3b).`);
  }
}
function parseSimpleEnv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

// ── secrets ─────────────────────────────────────────────────────────────────
function genSecrets() {
  return {
    BETTER_AUTH_SECRET: randomBytes(32).toString("base64"),
    STORE_API_KEY: randomBytes(24).toString("base64url"),
    MCP_LOGIN_TICKET_SECRET: randomBytes(32).toString("hex"),
  };
}
function secretPut(name, key, value, cwd) {
  const r = spawnSync("npx", ["wrangler", "secret", "put", key, "--name", name],
    { cwd, input: value + "\n", encoding: "utf8" });
  if (r.status !== 0) fail(`wrangler secret put ${key} (--name ${name}) failed:\n${(r.stderr || r.stdout || "").split("\n").slice(-8).join("\n")}`);
  ok(`secret ${key} → ${name}`);
}

// ── deploy helpers ──────────────────────────────────────────────────────────
function captureWorkersDevUrl(output) {
  const m = output.match(/https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev/i);
  return m?.[0] ?? null;
}
async function httpCheck(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeout ?? 20000);
  try {
    const res = await fetch(url, {
      method: opts.method ?? "GET", headers: opts.headers, body: opts.body, signal: ctrl.signal,
    });
    const text = await res.text().catch(() => "");
    return { status: res.status, text };
  } catch (err) {
    return { status: 0, text: String(err?.message ?? err) };
  } finally {
    clearTimeout(t);
  }
}
async function waitFor(label, fn, { tries = 24, delayMs = 5000 } = {}) {
  for (let i = 1; i <= tries; i++) {
    const r = await fn();
    if (r.ok) { ok(`${label} — ${r.detail}`); return r; }
    info(`${label} … waiting (${i}/${tries}) ${r.detail}`);
    await new Promise((r2) => setTimeout(r2, delayMs));
  }
  fail(`${label} never became ready.`);
}

// ════════════════════════════════════════════════════════════════════════════
async function main() {
  console.log(`
  ██████╗ᵒᵈᶠˡᵒʷ  Cloudflare deploy  ·  prefix '${CFG.prefix}'
  Runbook: .agents/skills/codflow-setup/SKILL.md
`);

  if (!CFG.dryRun) {
    const major = Number(process.versions.node.split(".")[0]);
    const minor = Number(process.versions.node.split(".")[1] ?? 0);
    if (major < 22 || (major === 22 && minor < 12)) fail(`Node.js >= 22.12 required, found ${process.version}.`);
  }

  // ── dry run: validate templating only ────────────────────────────────────
  if (CFG.dryRun) {
    step("Dry run — validate config generation (no network, no repo writes)");
    const fake = {
      serverWorker: NAMES.serverWorker, dashWorker: NAMES.dashWorker,
      dbName: NAMES.db, bucket: NAMES.bucket,
      dbId: "11111111-2222-3333-4444-555555555555",
      kvRate: "a".repeat(32), kvOAuth: "b".repeat(32),
      serverUrl: `https://${NAMES.serverWorker}.example.workers.dev`,
      dashUrl: `https://${NAMES.dashWorker}.example.workers.dev`,
      storeUrl: `https://${NAMES.themeWorker}.example.workers.dev`,
      betterAuthUrl: `https://${NAMES.dashWorker}.example.workers.dev/api/auth`,
      allowedOrigins: `https://${NAMES.dashWorker}.example.workers.dev,https://${NAMES.themeWorker}.example.workers.dev`,
      trustedOrigins: `https://${NAMES.dashWorker}.example.workers.dev`,
      mediaDomain: "media.example.net",
    };
    const serverTpl = readFileSync(join(SERVER_DIR, "wrangler.toml.example"), "utf8");
    const dashTpl = readFileSync(join(DASH_DIR, "wrangler.toml.example"), "utf8");
    const themeTpl = readFileSync(join(THEME_DIR, "wrangler.jsonc"), "utf8");
    const s = genServerToml(serverTpl, fake);
    const d = genDashToml(dashTpl, fake);
    const th = genThemeWrangler(themeTpl, NAMES.themeWorker);
    for (const [label, text] of [["server", s], ["dashboard", d]]) {
      const hard = HARD_PLACEHOLDER_RES.filter((re) => re.test(text));
      if (hard.length) fail(`dry-run: ${label} placeholders remain: ${hard.join(" ")}`);
      const code = stripTomlComments(text);
      const names = RESOURCE_NAME_RES.filter((re) => re.test(code));
      if (names.length) fail(`dry-run: ${label} resource names remain: ${names.join(" ")}`);
      // workers.dev example URLs are intentionally fake here; ensure OUR urls landed
      if (!text.includes(".example.workers.dev")) fail(`dry-run: ${label} missing injected URLs.`);
      if (!text.includes(fake.dbId) || !text.includes(fake.kvRate)) {
        fail(`dry-run: ${label} missing injected resource IDs.`);
      }
    }
    if (th.includes("codflow-os-theme01")) fail("dry-run: theme worker not renamed.");
    ok("server + dashboard + theme templates generate cleanly with zero placeholders");
    info("dry-run passed — run without --dry-run to deploy for real.");
    return;
  }

  // ── Step 0 — auth preflight ──────────────────────────────────────────────
  step("Preflight — Cloudflare authentication");
  const whoami = wrangler(["whoami"], { allowFail: true });
  if (/not authenticated|not logged in|authentication error|fetch failed/i.test(whoami)) {
    fail(`Wrangler is not authenticated.\nRun 'npx wrangler login' first, or export CLOUDFLARE_API_TOKEN (+ CLOUDFLARE_ACCOUNT_ID).\n--- whoami output ---\n${whoami.split("\n").slice(-10).join("\n")}`);
  }
  info(whoami.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 4).join(" · "));
  if (!CFG.accountId) {
    const m = whoami.match(/\b([0-9a-f]{32})\b/i);
    if (m) { CFG.accountId = m[1]; info(`Detected account id ${CFG.accountId}`); }
  }
  if (!CFG.accountId) {
    fail("Could not determine CLOUDFLARE_ACCOUNT_ID. Export it explicitly:\n  export CLOUDFLARE_ACCOUNT_ID='<your 32-hex account id>'");
  }
  process.env.CLOUDFLARE_ACCOUNT_ID = CFG.accountId;

  // ── Step 1 — install ─────────────────────────────────────────────────────
  step("Install dependencies (npm ci at repo root)");
  if (!existsSync(join(ROOT, "node_modules", ".package-lock.json"))) {
    sh("npm", ["ci"], { stdio: "inherit" });
  } else {
    ok("node_modules already installed — skipping npm ci");
  }

  // ── Step 2 — resources ───────────────────────────────────────────────────
  step(`Create Cloudflare resources (prefix '${CFG.prefix}')`);
  const dbId = ensureD1();
  ensureBucket();
  const kvRateId = ensureKv(NAMES.kvRate);
  const kvOAuthId = ensureKv(NAMES.kvOAuth);

  // ── Secrets (generate once, reuse on re-runs) ────────────────────────────
  step("Secrets — generate once, reuse on re-runs");
  let secrets = genSecrets();
  let adminPassword = CFG.adminPassword || randomBytes(12).toString("base64url");
  const serverDevVarsPath = join(SERVER_DIR, ".dev.vars");
  if (existsSync(serverDevVarsPath)) {
    const prev = parseSimpleEnv(readFileSync(serverDevVarsPath, "utf8"));
    if (prev.BETTER_AUTH_SECRET) secrets.BETTER_AUTH_SECRET = prev.BETTER_AUTH_SECRET;
    if (prev.STORE_API_KEY) secrets.STORE_API_KEY = prev.STORE_API_KEY;
    if (prev.MCP_LOGIN_TICKET_SECRET) secrets.MCP_LOGIN_TICKET_SECRET = prev.MCP_LOGIN_TICKET_SECRET;
    ok("reusing secrets from cod-server/.dev.vars");
  } else {
    ok("generated fresh BETTER_AUTH_SECRET / STORE_API_KEY / MCP_LOGIN_TICKET_SECRET");
  }
  if ((flag("--admin-password") ?? process.env.ADMIN_PASSWORD)) ok("using provided ADMIN_PASSWORD");

  // ── Step 3 — bind configs ────────────────────────────────────────────────
  step("Bind real IDs into wrangler.toml files + env files");
  const mediaDomain = CFG.mediaDomain || "media.example.com";
  if (!CFG.mediaDomain) warn("MEDIA_DOMAIN not provided — image uploads need Step 3b later (see summary).");
  const urls0 = {
    serverUrl: CFG.serverUrl || "http://localhost:8787",
    dashUrl: CFG.dashboardUrl || "https://dashboard.example.com",
    storeUrl: CFG.storeUrl || "",
    betterAuthUrl: (CFG.dashboardUrl || "https://dashboard.example.com") + "/api/auth",
    allowedOrigins: CFG.dashboardUrl
      ? [CFG.dashboardUrl, CFG.storeUrl].filter(Boolean).join(",") : "*",
    trustedOrigins: CFG.dashboardUrl || "https://dashboard.example.com",
    serverWorker: NAMES.serverWorker, dashWorker: NAMES.dashWorker,
    dbName: NAMES.db, bucket: NAMES.bucket, dbId, kvRate: kvRateId, kvOAuth: kvOAuthId, mediaDomain,
  };
  const serverTpl = readFileSync(join(SERVER_DIR, "wrangler.toml.example"), "utf8");
  const dashTpl = readFileSync(join(DASH_DIR, "wrangler.toml.example"), "utf8");
  // First pass may legitimately keep localhost/example URL vars (replaced post-deploy).
  let serverToml = genServerToml(serverTpl, urls0);
  let dashToml = genDashToml(dashTpl, urls0);
  const themeTpl = readFileSync(join(THEME_DIR, "wrangler.jsonc"), "utf8");
  const themeWrangler = genThemeWrangler(themeTpl, NAMES.themeWorker);
  writeFileSync(join(SERVER_DIR, "wrangler.toml"), serverToml);
  writeFileSync(join(DASH_DIR, "wrangler.toml"), dashToml);
  writeFileSync(join(THEME_DIR, "wrangler.jsonc"), themeWrangler);
  ok("cod-server/wrangler.toml + cod-client-astro/wrangler.toml + theme wrangler.jsonc written");
  for (const [f, t] of [["cod-server/wrangler.toml", serverToml], ["cod-client-astro/wrangler.toml", dashToml]]) {
    const res = [/00000000-0000/, /00000000000000000000000000000000/, /<your-/, /codflow-os-db/, /"codflow-images"/, /"codflow-server"/, /"codflow-dashboard"/];
    // Strip comment lines first: templates legitimately reference placeholder
    // names in docs comments (e.g. "# wrangler d1 create codflow-os-db"), and
    // only real config values are placeholders. Mirrors assertNoPlaceholders.
    const code = stripTomlComments(t);
    const hits = res.filter((re) => re.test(code));
    if (hits.length) fail(`${f} still contains resource placeholders: ${hits.join(" ")}`);
  }
  ok("resource-ID placeholder check passed (URL vars finalized after first deploy)");

  // root .env (unified cloud values for seeders / migration wrapper / theme deploy)
  const rootEnv =
    `# Generated by scripts/cloudflare-deploy.mjs — gitignored, do not commit.\n` +
    `COD_ACCOUNT_ID=${CFG.accountId}\n` +
    `COD_DB_NAME=${NAMES.db}\n` +
    `COD_R2_BUCKET_NAME=${NAMES.bucket}\n` +
    `COD_SERVER_URL=${urls0.serverUrl}\n` +
    `COD_MEDIA_DOMAIN=${mediaDomain}\n`;
  writeFileSync(join(ROOT, ".env"), rootEnv);
  process.env.COD_DB_NAME = NAMES.db;
  process.env.COD_SERVER_URL = urls0.serverUrl;
  process.env.COD_R2_BUCKET_NAME = NAMES.bucket;
  process.env.COD_ACCOUNT_ID = CFG.accountId;
  ok("root .env written (COD_DB_NAME etc.)");

  // .dev.vars files (local runs share the same secrets)
  const r2Block = (CFG.r2KeyId && CFG.r2Secret)
    ? `CF_ACCOUNT_ID=${CFG.accountId}\nR2_ACCESS_KEY_ID=${CFG.r2KeyId}\nR2_SECRET_ACCESS_KEY=${CFG.r2Secret}\n` : "";
  writeFileSync(serverDevVarsPath,
    `# Generated by scripts/cloudflare-deploy.mjs — gitignored.\n` +
    `STORE_API_KEY=${secrets.STORE_API_KEY}\n` +
    `BETTER_AUTH_SECRET=${secrets.BETTER_AUTH_SECRET}\n` +
    `MCP_LOGIN_TICKET_SECRET=${secrets.MCP_LOGIN_TICKET_SECRET}\n` + r2Block);
  writeFileSync(join(DASH_DIR, ".dev.vars"),
    `# Generated by scripts/cloudflare-deploy.mjs — gitignored.\n` +
    `BETTER_AUTH_SECRET=${secrets.BETTER_AUTH_SECRET}\n` +
    `MCP_LOGIN_TICKET_SECRET=${secrets.MCP_LOGIN_TICKET_SECRET}\n`);
  writeFileSync(join(DASH_DIR, ".env"), `PUBLIC_API_URL="${urls0.serverUrl}"\n`);
  ok(".dev.vars + dashboard .env written");
  if (!CFG.skipDeploy) {
    // deploy URLs discovered below; rewritten then
  }

  if (CFG.skipDeploy) {
    warn("--skip-deploy: stopping before worker deploys. Re-run without it to deploy.");
    return;
  }

  // ── Step 6a — deploy server ──────────────────────────────────────────────
  step("Deploy cod-server");
  let out = sh("npx", ["wrangler", "deploy"], { cwd: SERVER_DIR, label: "wrangler deploy (cod-server)" });
  let serverUrl = CFG.serverUrl || captureWorkersDevUrl(out);
  if (!serverUrl) fail(`Could not find workers.dev URL in deploy output. Re-run with --server-url=https://<worker>.<sub>.workers.dev\n--- output tail ---\n${out.split("\n").slice(-15).join("\n")}`);
  serverUrl = serverUrl.replace(/\/+$/, "");
  ok(`cod-server live at ${serverUrl}`);

  // ── Step 4 — secrets on server ───────────────────────────────────────────
  step("Set secrets on cod-server");
  secretPut(NAMES.serverWorker, "BETTER_AUTH_SECRET", secrets.BETTER_AUTH_SECRET, SERVER_DIR);
  secretPut(NAMES.serverWorker, "MCP_LOGIN_TICKET_SECRET", secrets.MCP_LOGIN_TICKET_SECRET, SERVER_DIR);
  if (CFG.r2KeyId && CFG.r2Secret) {
    secretPut(NAMES.serverWorker, "CF_ACCOUNT_ID", CFG.accountId, SERVER_DIR);
    secretPut(NAMES.serverWorker, "R2_ACCESS_KEY_ID", CFG.r2KeyId, SERVER_DIR);
    secretPut(NAMES.serverWorker, "R2_SECRET_ACCESS_KEY", CFG.r2Secret, SERVER_DIR);
  } else {
    warn("R2 API token not provided — presigned uploads stay disabled until Step 3b (see summary).");
  }

  // ── Step 5 — migrate + seed ──────────────────────────────────────────────
  step("Migrate + seed D1 (remote)");
  sh("npm", ["run", "db:migrate:local"], { cwd: SERVER_DIR, stdio: "inherit" });
  sh("npm", ["run", "db:migrate:remote"], { cwd: SERVER_DIR, stdio: "inherit" });
  if (!CFG.skipSeed) {
    let productCount = -1;
    if (!CFG.forceReseed) {
      const q = wrangler(["d1", "execute", NAMES.db, "--remote", "--command",
        "SELECT COUNT(*) AS c FROM products", "--json"], { cwd: SERVER_DIR, quiet: true, allowFail: true });
      const m = q.match(/"c"\s*:\s*(\d+)/);
      if (m) productCount = Number(m[1]);
    }
    if (productCount > 0 && !CFG.forceReseed) {
      ok(`catalog already seeded (${productCount} products) — skipping (use --force-reseed to re-seed)`);
    } else {
      sh("npm", ["run", "db:seed:remote"], {
        cwd: SERVER_DIR, stdio: "inherit", env: { STORE_API_KEY: secrets.STORE_API_KEY },
      });
    }
  } else {
    warn("SKIP_SEED=1 — demo catalog seed skipped");
  }
  sh("node", ["scripts/seed-admin.mjs", adminPassword, "--remote"], {
    cwd: DASH_DIR, stdio: "inherit",
    env: { ADMIN_EMAIL: CFG.adminEmail, ADMIN_NAME: CFG.adminName },
  });

  // ── Step 6b — deploy dashboard ───────────────────────────────────────────
  step("Build + deploy dashboard (cod-client-astro)");
  writeFileSync(join(DASH_DIR, ".env"), `PUBLIC_API_URL="${serverUrl}"\n`);
  dashToml = genDashToml(dashTpl, {
    ...urls0, serverUrl,
    dashUrl: CFG.dashboardUrl || urls0.dashUrl,
    trustedOrigins: CFG.dashboardUrl || urls0.trustedOrigins,
  });
  writeFileSync(join(DASH_DIR, "wrangler.toml"), dashToml);
  sh("npm", ["run", "build"], { cwd: DASH_DIR, stdio: "inherit", env: { PUBLIC_API_URL: serverUrl } });
  out = sh("npx", ["wrangler", "deploy"], { cwd: DASH_DIR, label: "wrangler deploy (dashboard)" });
  let dashUrl = CFG.dashboardUrl || captureWorkersDevUrl(out);
  if (!dashUrl) fail(`Could not find workers.dev URL in dashboard deploy output. Re-run with --dashboard-url=https://…\n--- output tail ---\n${out.split("\n").slice(-15).join("\n")}`);
  dashUrl = dashUrl.replace(/\/+$/, "");
  ok(`dashboard live at ${dashUrl}`);

  step("Set secrets on dashboard (same values as server)");
  secretPut(NAMES.dashWorker, "BETTER_AUTH_SECRET", secrets.BETTER_AUTH_SECRET, DASH_DIR);
  secretPut(NAMES.dashWorker, "MCP_LOGIN_TICKET_SECRET", secrets.MCP_LOGIN_TICKET_SECRET, DASH_DIR);

  // ── Step 6c — wire real URLs + redeploy ──────────────────────────────────
  step("Wire real URLs into both workers + redeploy");
  updateRootEnvUrl(serverUrl);
  serverToml = genServerToml(serverTpl, {
    ...urls0, serverUrl, mediaDomain,
    betterAuthUrl: `${dashUrl}/api/auth`,
    allowedOrigins: [dashUrl, CFG.storeUrl].filter(Boolean).join(",") || dashUrl,
    storeUrl: CFG.storeUrl || "",
  });
  writeFileSync(join(SERVER_DIR, "wrangler.toml"), serverToml);
  dashToml = genDashToml(dashTpl, {
    ...urls0, serverUrl, dashUrl, dashWorker: NAMES.dashWorker,
    trustedOrigins: dashUrl,
  });
  writeFileSync(join(DASH_DIR, "wrangler.toml"), dashToml);
  assertNoPlaceholders("cod-server/wrangler.toml", serverToml);
  assertNoPlaceholders("cod-client-astro/wrangler.toml", dashToml);
  ok("placeholder check passed — zero placeholders in either wrangler.toml");
  sh("npx", ["wrangler", "deploy"], { cwd: SERVER_DIR, label: "wrangler deploy (cod-server, final urls)" });
  ok("cod-server redeployed with real URLs");
  sh("npm", ["run", "build"], { cwd: DASH_DIR, stdio: "inherit", env: { PUBLIC_API_URL: serverUrl } });
  sh("npx", ["wrangler", "deploy"], { cwd: DASH_DIR, label: "wrangler deploy (dashboard, final urls)" });
  ok("dashboard rebuilt + redeployed with real URLs");

  // ── Step 6d — deploy storefront ──────────────────────────────────────────
  step("Deploy storefront (cod-astro/theme01)");
  out = sh("npm", ["run", "deploy"], { cwd: THEME_DIR, stdio: "pipe" });
  info(out.split("\n").slice(-6).join("\n"));
  let storeUrl = CFG.storeUrl || captureWorkersDevUrl(out);
  if (!storeUrl) {
    warn("Could not capture storefront URL from output — check Cloudflare dashboard → Workers.");
    storeUrl = "(see: npx wrangler deployments list --name " + NAMES.themeWorker + ")";
  } else {
    storeUrl = storeUrl.replace(/\/+$/, "");
    ok(`storefront live at ${storeUrl}`);
  }
  secretPut(NAMES.themeWorker, "STORE_API_KEY", secrets.STORE_API_KEY, THEME_DIR);
  if (CFG.mediaDomain) secretPut(NAMES.themeWorker, "MEDIA_DOMAIN", CFG.mediaDomain, THEME_DIR);
  // final server redeploy so ALLOWED_ORIGINS includes the store origin
  if (storeUrl.startsWith("http")) {
    serverToml = genServerToml(serverTpl, {
      ...urls0, serverUrl, mediaDomain,
      betterAuthUrl: `${dashUrl}/api/auth`,
      allowedOrigins: [dashUrl, storeUrl].join(","),
      storeUrl,
    });
    writeFileSync(join(SERVER_DIR, "wrangler.toml"), serverToml);
    sh("npx", ["wrangler", "deploy"], { cwd: SERVER_DIR, label: "wrangler deploy (cod-server, +store origin)" });
    ok("cod-server redeployed with store origin allowed");
  }

  // ── Smoke tests ──────────────────────────────────────────────────────────
  step("Smoke tests");
  await waitFor("cod-server /api/docs", async () => {
    const r = await httpCheck(`${serverUrl}/api/docs`);
    return r.status === 200
      ? { ok: true, detail: "200" }
      : { ok: false, detail: `HTTP ${r.status} ${r.text.slice(0, 80)}` };
  });
  await waitFor("dashboard sign-in (with Origin header)", async () => {
    const r = await httpCheck(`${dashUrl}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: dashUrl },
      body: JSON.stringify({ email: CFG.adminEmail, password: adminPassword }),
    });
    if (r.status === 200) return { ok: true, detail: "200 + session" };
    if (r.status === 403 && /ORIGIN/i.test(r.text)) {
      return { ok: false, detail: "403 INVALID_ORIGIN — redeploying dashboard to re-apply trusted origins…" };
    }
    return { ok: false, detail: `HTTP ${r.status} ${r.text.slice(0, 100)}` };
  }, { tries: 30, delayMs: 6000 });
  {
    const r = await httpCheck(dashUrl);
    r.status === 200 ? ok(`dashboard UI loads (${dashUrl})`)
      : warn(`dashboard UI returned HTTP ${r.status} — check ${dashUrl} in a browser.`);
  }
  if (storeUrl.startsWith("http")) {
    const r = await httpCheck(storeUrl);
    r.status === 200 ? ok(`storefront loads (${storeUrl})`)
      : warn(`storefront returned HTTP ${r.status}.`);
    warn("workers.dev → workers.dev fetches are blocked by Cloudflare (error 1042): the storefront may render without products until cod-server gets a custom domain. See summary.");
  }

  // ── Step 7 — summary + credentials file ──────────────────────────────────
  step("Done — resource inventory");
  const credPath = join(homedir(), `codflow-${CFG.prefix}-credentials.md`);
  const creds =
    `# CodFlow Credentials — ${CFG.prefix}\n\n` +
    `Generated ${new Date().toISOString()} by scripts/cloudflare-deploy.mjs.\n\n` +
    `## Admin\n- **Dashboard:** ${dashUrl}\n- **Email:** \`${CFG.adminEmail}\`\n- **Password:**\n  \`\`\`\n  ${adminPassword}\n  \`\`\`\n\n` +
    `## API keys\n- **BETTER_AUTH_SECRET:**\n  \`\`\`\n  ${secrets.BETTER_AUTH_SECRET}\n  \`\`\`\n` +
    `- **MCP_LOGIN_TICKET_SECRET:**\n  \`\`\`\n  ${secrets.MCP_LOGIN_TICKET_SECRET}\n  \`\`\`\n` +
    `- **STORE_API_KEY:**\n  \`\`\`\n  ${secrets.STORE_API_KEY}\n  \`\`\`\n\n` +
    `## URLs\n- Server API: ${serverUrl} (docs: ${serverUrl}/api/docs)\n- Dashboard: ${dashUrl}\n- Storefront: ${storeUrl}\n\n` +
    `## Resources\n- D1: ${NAMES.db} (${dbId})\n- R2: ${NAMES.bucket}\n- KV: ${NAMES.kvRate} (${kvRateId}), ${NAMES.kvOAuth} (${kvOAuthId})\n\n` +
    `**Security:** store in a password manager, then delete this file.\n`;
  writeFileSync(credPath, creds, { mode: 0o600 });
  chmodSync(credPath, 0o600);

  // CI handoff (GitHub Actions): non-secret summary for the job summary page.
  const outputFile = process.env.CF_DEPLOY_OUTPUT_FILE;
  if (outputFile) {
    writeFileSync(outputFile, [
      `SERVER_URL=${serverUrl}`,
      `DASHBOARD_URL=${dashUrl}`,
      `STOREFRONT_URL=${storeUrl}`,
      `ADMIN_EMAIL=${CFG.adminEmail}`,
      `D1_NAME=${NAMES.db}`,
      `D1_ID=${dbId}`,
      `R2_BUCKET=${NAMES.bucket}`,
      `KV_RATE_NAME=${NAMES.kvRate}`,
      `KV_RATE_ID=${kvRateId}`,
      `KV_OAUTH_NAME=${NAMES.kvOAuth}`,
      `KV_OAUTH_ID=${kvOAuthId}`,
      `PREFIX=${CFG.prefix}`,
    ].join("\n") + "\n");
    ok(`deploy summary written to ${outputFile}`);
  }

  console.log(`
  Resource inventory
  ──────────────────────────────────────────────────────────────
  D1  ${NAMES.db}  ${dbId}
  R2  ${NAMES.bucket}
  KV  ${NAMES.kvRate}  ${kvRateId}
  KV  ${NAMES.kvOAuth}  ${kvOAuthId}

  Server      ${serverUrl}
  Dashboard   ${dashUrl}   login: ${CFG.adminEmail}
  Storefront  ${storeUrl}

  Credentials file (chmod 600): ${credPath}
`);
  if (!CFG.mediaDomain || !CFG.r2KeyId) {
    console.log(`  Remaining — R2 image uploads (runbook Step 3b, needs dashboard clicks):`);
    if (!CFG.mediaDomain) console.log(`   1. R2 → ${NAMES.bucket} → Settings → Custom Domains → connect media.yourdomain.com`);
    if (!CFG.r2KeyId) console.log(`   2. R2 → Manage R2 API Tokens → Create (Object Read & Write on ${NAMES.bucket}) → copy Access Key ID + Secret`);
    console.log(`   3. Re-run with: MEDIA_DOMAIN=media.yourdomain.com R2_ACCESS_KEY_ID=… R2_SECRET_ACCESS_KEY=… npm run deploy:cloudflare`);
    console.log(`   4. R2 → bucket → Settings → CORS Policy → paste:`);
    console.log(JSON.stringify([{
      AllowedOrigins: [dashUrl, "http://localhost:4321"],
      AllowedMethods: ["PUT", "GET", "HEAD"],
      AllowedHeaders: ["Content-Type", "Content-Length"],
      ExposeHeaders: ["ETag"], MaxAgeSeconds: 3600,
    }], null, 2));
  }
  if (!CFG.storeUrl) {
    console.log(`
  Note — storefront catalog on workers.dev: Cloudflare blocks Worker→Worker
  fetch between two *.workers.dev hosts (error 1042), so the storefront may
  show no products until cod-server is on a custom domain. Fix: Workers →
  ${NAMES.serverWorker} → Settings → Domains & Routes → Add custom domain
  (e.g. api.yourdomain.com), then re-run with COD_SERVER_URL exported? No —
  just re-run: --server-url=https://api.yourdomain.com … --dashboard-url=${dashUrl}`);
  }
  console.log(`
  Updates: when CodFlow publishes an update, ask your AI agent to
  'update CodFlow' (.agents/skills/codflow-update/SKILL.md) — never re-run
  setup from scratch.
`);
}

function updateRootEnvUrl(serverUrl) {
  const p = join(ROOT, ".env");
  let t = readFileSync(p, "utf8");
  t = t.replace(/^COD_SERVER_URL=.*$/m, `COD_SERVER_URL=${serverUrl}`);
  writeFileSync(p, t);
  process.env.COD_SERVER_URL = serverUrl;
  ok(`root .env COD_SERVER_URL → ${serverUrl}`);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) main().catch((err) => { console.error(err); process.exit(1); });

export {
  genServerToml, genDashToml, genThemeWrangler, assertNoPlaceholders,
  stripTomlComments, replaceTomlVar, replaceInlineVar, parseSimpleEnv,
  captureWorkersDevUrl,
};
