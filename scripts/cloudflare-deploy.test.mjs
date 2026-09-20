/**
 * Unit tests for the pure helpers of scripts/cloudflare-deploy.mjs.
 * Run with: npm run test:scripts   (Node's built-in test runner, no deps)
 *
 * Regression: "Deploy update (workers only)" failed on every run with
 * "R2 bucket 'codflowv2-images' not found" because wrangler 4.x prints
 * `r2 bucket list` as labelled values ("name:  <bucket>") and the parser only
 * understood JSON or a whitespace table.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBucketList, tryJson, stripAnsi, captureWorkersDevUrl } from "./cloudflare-deploy.mjs";

test("parseBucketList reads wrangler 4.x labelled output", () => {
  const out = [
    "Listing buckets...",
    "name:           codflowv2-images",
    "creation_date:  2026-09-14T10:22:31.000Z",
    "",
    "name:           other-bucket",
    "creation_date:  2026-01-01T00:00:00.000Z",
    "",
  ].join("\n");
  assert.deepEqual(parseBucketList(out), ["codflowv2-images", "other-bucket"]);
});

test("parseBucketList ignores ANSI colour codes", () => {
  const out = "\u001b[36mListing buckets...\u001b[0m\n\u001b[37mname:\u001b[0m           \u001b[90mcodflowv2-images\u001b[0m\n\u001b[37mcreation_date:\u001b[0m  \u001b[90m2026-09-14\u001b[0m\n";
  assert.deepEqual(parseBucketList(out), ["codflowv2-images"]);
});

test("parseBucketList still understands JSON and legacy tables", () => {
  assert.deepEqual(parseBucketList('[{"name":"codflowv2-images","creation_date":"x"}]'), ["codflowv2-images"]);
  assert.deepEqual(parseBucketList('["a","b"]'), ["a", "b"]);
  assert.deepEqual(parseBucketList("codflowv2-images   2026-09-14\nfoo   2025-01-01\n"), ["codflowv2-images", "foo"]);
});

test("parseBucketList returns an empty list for an empty account", () => {
  assert.deepEqual(parseBucketList("Listing buckets...\n"), []);
  assert.deepEqual(parseBucketList(""), []);
});

test("tryJson tolerates a banner before the JSON payload", () => {
  assert.deepEqual(tryJson('⛅️ wrangler 4.125.0\n────────\n[{"title":"codflowv2-rate-limit","id":"abc"}]\n'), [
    { title: "codflowv2-rate-limit", id: "abc" },
  ]);
  assert.equal(tryJson("A namespace with this title already exists. [code: 10014]"), null);
  assert.equal(tryJson(""), null);
});

test("stripAnsi removes escape sequences only", () => {
  assert.equal(stripAnsi("\u001b[32m✓\u001b[0m done"), "✓ done");
  assert.equal(stripAnsi("plain"), "plain");
});

test("captureWorkersDevUrl finds the deployed worker URL", () => {
  assert.equal(
    captureWorkersDevUrl("Deployed codflowv2-server triggers (1.2 sec)\n  https://codflowv2-server.tahar.workers.dev\n"),
    "https://codflowv2-server.tahar.workers.dev",
  );
  assert.equal(captureWorkersDevUrl("no url here"), null);
});

test("bucketInfoSaysExists recognises `r2 bucket info` output (labelled or JSON) and rejects errors", async () => {
  const { bucketInfoSaysExists } = await import("./cloudflare-deploy.mjs");
  const labelled = "Getting info for 'codflowv2-images'...\nname:                   codflowv2-images\ncreated:                2026-09-14T10:22:31.000Z\nlocation:               WEUR\n";
  assert.equal(bucketInfoSaysExists(labelled, "codflowv2-images"), true);
  assert.equal(bucketInfoSaysExists(labelled, "codflowv2-image"), false);
  assert.equal(bucketInfoSaysExists('{"name":"codflowv2-images","created":"x"}', "codflowv2-images"), true);
  assert.equal(bucketInfoSaysExists("✘ [ERROR] The specified bucket does not exist. [code: 10006]", "codflowv2-images"), false);
  assert.equal(bucketInfoSaysExists("name: bucket.with.dots\n", "bucket.with.dots"), true);
  assert.equal(bucketInfoSaysExists("name: bucketXwithXdots\n", "bucket.with.dots"), false);
});
